import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { Block } from "./block";
import { OP_eval } from "./builtins";
import { makeOpcode, NOTHING } from "./define";
import { Env } from "./env";
import { JEBError, JEBSyntaxError, JEBValueError, wrapThrowToError } from "./errors";
import { CallableSignature, Laziness, LonghandArgument } from "./signature";
import { Identifier } from "./utils";
import { JebVM, popData, pushCommand, pushData } from "./vm";
import { KeywordArg, SplatArg } from "./wrapper";
import { OP_unwrap } from "./unwrap";

const enum DoargsWhere {
    _BLANK,
    POSITIONAL,
    KEYWORD,
}

const MISSING = Symbol("MISSING");

export class DoargsState {
    readonly #name: Identifier | undefined;
    readonly #params: CallableSignature;
    readonly #argsObj: Record<string, any>;
    readonly #callEnv: Env;
    readonly #closureEnv: Env | undefined;
    readonly #noEvalMode: boolean;
    readonly #givenArgs: any[];
    readonly #rawArgsIndex: number;
    readonly #paramsIndex: number;
    readonly #seenKeyword: boolean;
    readonly #seenByName: Readonly<Record<string, DoargsWhere>>;

    constructor(name: Identifier | undefined, params: CallableSignature, call: Env, closure: Env | undefined, noEval: boolean, given: any[], argsObj: Record<string, any> = {}, rawArgsIndex = 0, paramsIndex = 0, seenKeyword = false, seenByName: Record<string, DoargsWhere> = {}) {
        this.#name = name;
        this.#params = params;
        this.#callEnv = call;
        this.#closureEnv = closure;
        this.#noEvalMode = noEval;
        this.#givenArgs = given;
        this.#argsObj = argsObj;
        this.#rawArgsIndex = rawArgsIndex;
        this.#paramsIndex = paramsIndex;
        this.#seenKeyword = seenKeyword;
        this.#seenByName = seenByName;
        if (params.rest) {
            this.#argsObj[params.rest.name] ??= [];
        }
        if (params.kwRest) {
            this.#argsObj[params.kwRest.name] ??= {};
        }
    }

    #update(argsObj = this.#argsObj, seenByName = this.#seenByName, rawArgsIndex = this.#rawArgsIndex, paramsIndex = this.#paramsIndex, seenKeyword = this.#seenKeyword) {
        return new DoargsState(this.#name, this.#params, this.#callEnv, this.#closureEnv, this.#noEvalMode, this.#givenArgs, argsObj, rawArgsIndex, paramsIndex, seenKeyword, seenByName);
    }

    run(vm: JebVM, first: boolean) {
        var state: DoargsState = this;
        for (; ; first = true) {
            // There are three phases to the argument processing:
            // 1. Prepare argument value.
            // 2. Optionally evaluate it if needed.
            // 3. Store the value to the arguments object.
            const argValue = first ? state.#prepareNextValue(vm) : popData(vm);
            // prepareValue returns NOTHING if it pushed opcodes to do something,
            // otherwise it returns the value as-is
            if (argValue === NOTHING) return;
            state = state.#storeArgumentAndAdvance(argValue);
        }
    }
    // Also prepares evaluation or handles end-of-arguments
    #prepareNextValue(vm: JebVM) {
        const paramsList = this.#params.params, argv = this.#givenArgs;
        const curParamIndex = this.#paramsIndex, curArgvIndex = this.#rawArgsIndex;

        const evalHelper = (env: Env, data: any, param?: LonghandArgument<any, any>) => {
            pushCommand(vm, OP_doargs_loop, this, false);
            pushCommand(vm, OP_unwrap, ["splat", "keyword"].concat(param?.flags));
            pushCommand(vm, OP_eval, undefined);
            pushData(vm, data);
            vm.currentEnv = env;
            return NOTHING;
        };

        const doneHelper = (ao = this.#argsObj) => {
            vm.currentEnv = this.#callEnv;
            pushData(vm, ao);
            return NOTHING;
        };

        if (curArgvIndex < argv.length) {
            if (curParamIndex >= paramsList.length) {
                // If rest argument is lazy, slice off everything at once and wrap it
                if (this.#params.rest) {
                    const { lazy, name } = this.#params.rest;
                    if (lazy !== Laziness.NONE) {
                        if (this.#noEvalMode) throw new JEBSyntaxError("lazy parameter not allowed here");
                        return doneHelper({ ...this.#argsObj, [name!]: wrapLazyValue(lazy, argv.slice(curArgvIndex), this.#callEnv, false) });
                    }
                }
            }
            const value = argv[curArgvIndex]!;
            const param = paramsList[curParamIndex];
            if (param && param.lazy !== Laziness.NONE) {
                if (this.#noEvalMode) throw new JEBSyntaxError("lazy parameter not allowed here");
                return wrapLazyValue(param.lazy, value, this.#callEnv, true);
            }
            return this.#noEvalMode ? value : evalHelper(this.#callEnv, value, param);
        }

        if (curParamIndex >= paramsList.length) {
            // Done!
            return doneHelper();
        }

        const param = paramsList[curParamIndex]!;
        return param.required ? MISSING : evalHelper(this.#closureEnv ? vm.createEnv(this.#callEnv, this.#closureEnv) : vm.createEnv(this.#callEnv), param.defaultExpr, param);
    }

    #storeArgumentAndAdvance(argValue: any) {
        const param = this.#params.params[this.#paramsIndex]!;
        if (param?.required && argValue === MISSING) {
            if (this.#seenKeyword && this.#seenByName[param.name]) {
                // Skip keyword-given indices
                return this.#update(undefined, undefined, undefined, this.#paramsIndex + 1);
            }
            else throw new JEBValueError(`missing required parameter ${stringify(param.name)} of function ${stringify(this.#name)}`);
        }
        if (isinstance(argValue, KeywordArg)) {
            return this.#storeKeyword(argValue.name, argValue.obj, false, 1);
        }
        if (isinstance(argValue, SplatArg)) {
            if (argValue.isKeyword) {
                const values = { ...argValue.obj }, names = Reflect.ownKeys(values);
                var state: DoargsState = this;
                const len = names.length;
                for (var i = 0; i < len; i++) {
                    const name = names[i]!, value = values[name];
                    state.#assertNotSpecial(value);
                    state = state.#storeKeyword(name, value, true, 0);
                }
                return state.#update(undefined, undefined, state.#rawArgsIndex + 1);
            } else {
                const values = [...argValue.obj];
                var state: DoargsState = this;
                const len = values.length;
                for (var i = 0; i < len; i++) {
                    const value = values[i];
                    state.#assertNotSpecial(value);
                    state = state.#storePositional(value, true, 1, 0);
                }
                return state.#update(undefined, undefined, state.#rawArgsIndex + 1);
            }
        }
        return this.#storePositional(argValue, false, 1, 1);
    }
    #assertNotSpecial(value: any) {
        if (isinstance(value, KeywordArg) || isinstance(value, SplatArg)) {
            throw new JEBError("TODO: what happens when a keyword/splat wrapper is inside another argument wrapper?");
        }
    }

    #storeKeyword(name: Identifier, obj: any, isFromSplat: boolean, rawDelta: number) {
        if (!this.#params.params.some(({ name: name2 }) => name === name2)) {
            const p = this.#params.kwRest;
            if (p) {
                return this.#update({ ...this.#argsObj, [p.name]: { ...(this.#argsObj[p.name] ?? {}), [name]: obj } }, undefined, this.#rawArgsIndex + 1);
            }
            throw new JEBValueError(`unexpected ${isFromSplat ? "splat " : ""}keyword argument ${stringify(name)} to function ${stringify(this.#name)}`);
        }
        return this.#update({ ...this.#argsObj, [name]: obj }, { ...this.#seenByName, [name]: DoargsWhere.KEYWORD }, this.#rawArgsIndex + rawDelta, undefined, true);
    }
    #storePositional(value: any, isFromSplat: boolean, paramsDelta: number, rawDelta: number): DoargsState {
        if (this.#seenKeyword) {
            throw new JEBSyntaxError("positional argument can't follow keyword argument");
        }
        this.#assertNotSpecial(value);
        const pList = this.#params.params, index = this.#paramsIndex;
        if (index >= pList.length) {
            const p = this.#params.rest;
            if (p) {
                if (p.lazy !== Laziness.NONE && isFromSplat) {
                    throw new JEBValueError("cannot unpack splat argument into lazy rest parameter");
                }
                return this.#update({ ...this.#argsObj, [p.name]: [...(this.#argsObj[p.name] ?? []), value] }, undefined, this.#rawArgsIndex + rawDelta, this.#paramsIndex + paramsDelta);
            }
            if (isFromSplat) {
                throw new JEBValueError(`too many elements in splat argument to function ${stringify(this.#name)} (at most ${pList.length - index + 1} can be passed here)`);
            } else {
                throw new JEBValueError(`too many arguments to function ${stringify(this.#name)} (expected at most ${pList.length})`);
            }
        }
        const { name, lazy } = pList[index]!;
        if (lazy !== Laziness.NONE && isFromSplat) {
            throw new JEBValueError(`cannot unpack splat argument into lazy parameter ${stringify(name)} of function ${stringify(this.#name)}`);
        }
        const g = this.#seenByName[name];
        if (g) {
            throw new JEBValueError(`argument ${stringify(name)} of function ${stringify(this.#name)} already given as ${g === DoargsWhere.KEYWORD ? "keyword" : "positional"} argument`);
        }
        return this.#update({ ...this.#argsObj, [name]: value }, { ...this.#seenByName, [name]: DoargsWhere.POSITIONAL }, this.#rawArgsIndex + rawDelta, this.#paramsIndex + paramsDelta);
    }
}

const wrapLazyValue = (laziness: Laziness.LAZY | Laziness.QUOTED, given: any[], env: Env, isSingle: boolean) => {
    return laziness === Laziness.QUOTED ? given : new Block(env, isSingle ? [given] : given);
}

export const OP_doargs = makeOpcode("doargs", (vm, { 0: params, 1: env, 2: noEval, 3: name }: [CallableSignature, Env | undefined, boolean | undefined, Identifier | undefined]) => {
    const given = popData(vm);
    // Optimization: test if it's all one rest lazy parameter, just special-case that
    const { params: { length }, rest } = params;
    if (!length && rest) {
        if (rest.lazy !== Laziness.NONE) {
            pushData(vm, { [rest.name]: wrapLazyValue(rest.lazy, given, vm.currentEnv, false) });
            return;
        }
    }
    pushCommand(vm, OP_doargs_loop, new DoargsState(name, params, vm.currentEnv, env, noEval ?? false, given), true);
},
    `.imm params env
.param {CallableSignature} params - the signature of the thing being called
.param {Env?} env - the closure environment that the default parameters need
.sed argslist -- argsobj
. Processes the given arguments list into the named arguments object as determined by the signature.`);

const OP_doargs_loop = makeOpcode(null, (vm, { 0: state, 1: first }) => wrapThrowToError(JEBValueError, () => state.run(vm, first)), null);

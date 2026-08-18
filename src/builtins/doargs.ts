import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { CallableSignature, Laziness, LonghandArgument } from "../callable";
import { Env } from "../env";
import { JEBError, JEBSyntaxError, JEBValueError, wrapThrowToError } from "../errors";
import { JebVM } from "../vm";
import { KeywordArg, SplatArg } from "../wrapper";
import { defineOpcode, NOTHING } from "./define";

const enum DoargsWhere {
    _BLANK,
    POSITIONAL,
    KEYWORD,
}

export class DoargsState {
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

    constructor(params: CallableSignature, call: Env, closure: Env | undefined, noEval: boolean, given: any[], argsObj: Record<string, any> = {}, rawArgsIndex = 0, paramsIndex = 0, seenKeyword = false, seenByName: Record<string, DoargsWhere> = {}) {
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

    #update({ argsObj = this.#argsObj, seenByName = this.#seenByName, rawArgsIndex = this.#rawArgsIndex, paramsIndex = this.#paramsIndex, seenKeyword = this.#seenKeyword } = {}) {
        return new DoargsState(this.#params, this.#callEnv, this.#closureEnv, this.#noEvalMode, this.#givenArgs, argsObj, rawArgsIndex, paramsIndex, seenKeyword, seenByName);
    }

    run(vm: JebVM, first: boolean) {
        var state: DoargsState = this;
        for (; ; first = true) {
            // There are three phases to the argument processing:
            // 1. Prepare argument value.
            // 2. Optionally evaluate it if needed.
            // 3. Store the value to the arguments object.
            const argValue = first ? state.#prepareNextValue(vm) : vm.popData();
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
            vm.pushCommand("jeb:doargs/loop", this, false);
            vm.pushCommand("jeb:unwrap", ["splat", "keyword"].concat(param?.flags));
            vm.pushCommand("jeb:eval");
            vm.pushData(data);
            vm.currentEnv = env;
            return NOTHING;
        };

        const doneHelper = () => {
            vm.currentEnv = this.#callEnv;
            vm.pushData(this.#argsObj);
            return NOTHING;
        };

        if (curArgvIndex < argv.length) {
            if (curParamIndex >= paramsList.length) {
                // If rest argument is lazy, slice off everything at once and wrap it
                if (this.#params.rest) {
                    const { lazy, name } = this.#params.rest;
                    if (lazy !== Laziness.NONE) {
                        if (this.#noEvalMode) throw new JEBSyntaxError("lazy parameter not allowed here");
                        const argsObj = { ...this.#argsObj, [name!]: wrapLazyValue(lazy, argv.slice(curArgvIndex), this.#callEnv) };
                        vm.currentEnv = this.#callEnv;
                        vm.pushData(argsObj);
                        return NOTHING;
                    }
                }
            }
            const value = argv[curArgvIndex]!;
            const param = paramsList[curParamIndex];
            if (param && param.lazy !== Laziness.NONE) {
                if (this.#noEvalMode) throw new JEBSyntaxError("lazy parameter not allowed here");
                return wrapLazyValue(param.lazy, value, this.#callEnv);
            }
            return this.#noEvalMode ? value : evalHelper(this.#callEnv, value, param);
        }

        if (curParamIndex >= paramsList.length) {
            // Done!
            return doneHelper();
        }

        const param = paramsList[curParamIndex]!;
        if (!param.required) {
            return evalHelper(this.#closureEnv ? vm.createEnv(this.#callEnv, this.#closureEnv) : vm.createEnv(this.#callEnv), param.defaultExpr, param);
        } else {
            throw new JEBValueError(`missing required parameter ${stringify(param.name)}`);
        }
    }

    #storeArgumentAndAdvance(argValue: any) {
        if (isinstance(argValue, KeywordArg)) {
            return this.#storeKeyword(argValue);
        }
        if (isinstance(argValue, SplatArg)) {
            if (argValue.isKeyword) {
                throw new JEBError("Keyword splat arg not implemented yet");
            }
            const values = [...argValue.obj];
            var state: DoargsState = this;
            for (var i = 0; i < values.length; i++) {
                const value = values[i];
                state.#assertNotSpecial(value);
                state = state.#storePositional(value, true, 1, 0);
            }
            return state.#update({ rawArgsIndex: state.#rawArgsIndex + 1 });
        }
        return this.#storePositional(argValue, false, 1, 1);
    }
    #assertNotSpecial(value: any) {
        if (isinstance(value, KeywordArg) || isinstance(value, SplatArg)) {
            throw new JEBError("TODO: what happens when a keyword/splat wrapper is inside another argument wrapper?");
        }
    }

    #storeKeyword({ obj, name }: KeywordArg) {
        if (!this.#params.params.some(({ name: name2 }) => name === name2)) {
            const p = this.#params.kwRest;
            if (p) {
                return this.#update({
                    argsObj: { ...this.#argsObj, [p.name]: { ...(this.#argsObj[p.name] ?? {}), [name]: obj } },
                    rawArgsIndex: this.#rawArgsIndex + 1,
                });
            }
            throw new JEBValueError(`unexpected keyword argument ${stringify(name)}`);
        }
        return this.#update({
            argsObj: { ...this.#argsObj, [name]: obj },
            seenByName: { ...this.#seenByName, [name]: DoargsWhere.KEYWORD },
            rawArgsIndex: this.#rawArgsIndex + 1,
            seenKeyword: true,
        });
    }
    #storePositional(value: any, isFromSpread: boolean, paramsDelta: number, rawDelta: number): DoargsState {
        if (this.#seenKeyword) {
            throw new JEBSyntaxError("keyword argument can't follow positional argument");
        }
        this.#assertNotSpecial(value);
        const pList = this.#params.params, index = this.#paramsIndex;
        if (index >= pList.length) {
            const p = this.#params.rest;
            if (p) {
                if (p.lazy !== Laziness.NONE && isFromSpread) {
                    throw new JEBValueError("cannot unpack spread argument into lazy rest parameter");
                }
                return this.#update({
                    argsObj: { ...this.#argsObj, [p.name]: [...(this.#argsObj[p.name] ?? []), value] },
                    paramsIndex: this.#paramsIndex + paramsDelta,
                    rawArgsIndex: this.#rawArgsIndex + rawDelta,
                });
            }
            throw new JEBValueError(`too many ${isFromSpread ? "elements in spread argument" : "arguments"}`);
        }
        const { name, lazy } = pList[index]!;
        if (lazy !== Laziness.NONE && isFromSpread) {
            throw new JEBValueError("cannot unpack spread argument into lazy parameter");
        }
        const g = this.#seenByName[name];
        if (g) {
            throw new JEBValueError(`argument ${stringify(name)} already given as ${g === DoargsWhere.KEYWORD ? "keyword" : "positional"} argument`);
        }
        return this.#update({
            argsObj: { ...this.#argsObj, [name]: value },
            seenByName: { ...this.#seenByName, [name]: DoargsWhere.POSITIONAL },
            paramsIndex: this.#paramsIndex + paramsDelta,
            rawArgsIndex: this.#rawArgsIndex + rawDelta,
        });
    }
}

const wrapLazyValue = (laziness: Laziness.LAZY | Laziness.QUOTED, given: any, env: Env) => {
    return laziness === Laziness.QUOTED ? given : new Block(env, given); // lmao Block doesn't exist yet, this is on purpose
}

export const registerDoargs = (vm: JebVM) => {
    defineOpcode(vm, "jeb:doargs", (vm, { 0: params, 1: env, 2: noEval }) => {
        const given = vm.popData();
        // Optimization: test if it's all one rest lazy parameter, just special-case that
        const { params: { length }, rest } = params;
        if (!length && rest) {
            if (rest.lazy !== Laziness.NONE) {
                vm.pushData({ [rest.name]: wrapLazyValue(rest.lazy, given, vm.currentEnv) });
                return;
            }
        }
        vm.pushCommand("jeb:doargs/loop", new DoargsState(params, vm.currentEnv, env, noEval, given), true);
    },
        `.imm params env
.param {CallableSignature} params - the signature of the thing being called
.param {Env?} env - the closure environment that the default parameters need
.sed argslist -- argsobj
. Processes the given arguments list into the named arguments object as determined by the signature.`);
    defineOpcode(vm, "jeb:doargs/loop", (vm, { 0: state, 1: first }) => wrapThrowToError(vm, JEBValueError, () => state.run(vm, first)), null);
}

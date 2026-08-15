import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { CallableSignature, Laziness, LonghandArgument } from "../callable";
import { Env } from "../env";
import { wrapThrowToError } from "../errors";
import { JebVM } from "../vm";
import { KeywordArg, SplatArg } from "../wrapper";
import { defineOpcode, NOTHING } from "./define";

const enum DoargsWhere {
    _BLANK,
    POSITIONAL,
    KEYWORD,
}

export class DoargsState {
    #params: CallableSignature;
    #argsObj: Record<string, any> = {};
    #callEnv: Env;
    #closureEnv: Env | undefined;
    #givenArgs: any[];
    #rawArgsIndex = 0;
    #paramsIndex = 0;
    #seenKeyword = false;
    #seenByName: Record<string, DoargsWhere> = {};
    constructor(params: CallableSignature, call: Env, closure: Env | undefined, given: any[]) {
        this.#params = params;
        this.#callEnv = call;
        this.#closureEnv = closure;
        this.#givenArgs = given;
        if (params.rest) {
            this.#argsObj[params.rest.name] = [];
        }
        if (params.kwRest) {
            this.#argsObj[params.kwRest.name] = {};
        }
    }
    run(vm: JebVM, first: boolean) {
        for (; ; first = true) {
            // There are three phases to the argument processing:
            // 1. Prepare argument value.
            // 2. Optionally evaluate it if needed.
            // 3. Store the value to the arguments object.
            const argValue = first ? this.#prepareNextValue(vm) : vm.popData();
            // prepareValue returns NOTHING if it pushed opcodes to do something,
            // otherwise it returns the value as-is
            if (argValue === NOTHING) return;
            this.#storeArgumentAndAdvance(argValue);
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
                const { lazy, name } = this.#params.rest ?? {};
                if (lazy === Laziness.QUOTED) {
                    this.#argsObj[name] = argv.slice(curArgvIndex);
                    return doneHelper();
                }
            }
            const value = argv[curArgvIndex]!;
            const param = paramsList[curParamIndex];
            if (param && param.lazy !== Laziness.NONE) return wrapLazyValue(param.lazy, value, this.#callEnv);
            return evalHelper(this.#callEnv, value, param);
        }

        if (curParamIndex >= paramsList.length) {
            // Done!
            return doneHelper();
        }

        const param = paramsList[curParamIndex]!;
        if (!param.required) {
            return evalHelper(this.#closureEnv ? vm.createEnv(this.#callEnv, this.#closureEnv) : vm.createEnv(this.#callEnv), param.defaultExpr, param);
        } else {
            throw new Error(`missing required parameter ${stringify(param.name)}`);
        }
    }
    #storeArgumentAndAdvance(argValue: any) {
        if (isinstance(argValue, KeywordArg)) {
            this.#storeKeyword(argValue);
        } else if (isinstance(argValue, SplatArg)) {
            if (argValue.isKeyword) {
                throw new Error("Keyword splat arg not implemented yet");
            }
            const values = [...argValue.obj]; // Force an error thrown if it's not iterable
            for (var i = 0; i < values.length; i++) {
                const value = values[i];
                this.#assertNotSpecial(value);
                this.#storePositional(value, true);
                this.#paramsIndex++;
            }
        } else {
            this.#storePositional(argValue, false);
            this.#paramsIndex++;
        }
        this.#rawArgsIndex++;
    }
    #assertNotSpecial(value: any) {
        if (isinstance(value, KeywordArg) || isinstance(value, SplatArg)) {
            throw new Error("TODO: what happens when a keyword/splat wrapper is inside another argument wrapper?");
        }
    }
    #storeKeyword({ obj, name }: KeywordArg) {
        if (!this.#params.params.some(({ name: name2 }) => name === name2)) {
            const p = this.#params.kwRest;
            if (p) {
                this.#argsObj[p.name][name] = obj;
                return;
            }
            throw new Error(`unexpected keyword argument ${stringify(name)}`);
        }
        this.#seenKeyword = true;
        this.#put(obj, name, DoargsWhere.KEYWORD);
    }
    #storePositional(value: any, isFromSpread: boolean) {
        if (this.#seenKeyword) {
            throw new Error("keyword argument can't follow positional argument");
        }
        this.#assertNotSpecial(value);
        const pList = this.#params.params, index = this.#paramsIndex;
        if (index >= pList.length) {
            const p = this.#params.rest;
            if (p) {
                if (p.lazy !== Laziness.NONE && isFromSpread) {
                    throw new Error("cannot unpack spread argument into lazy rest parameter");
                }
                this.#argsObj[p.name].push(value);
                return;
            }
            throw new Error(`too many ${isFromSpread ? "elements in spread argument" : "arguments"}`);
        }
        const { name, lazy } = pList[index]!;
        if (lazy !== Laziness.NONE && isFromSpread) {
            throw new Error("cannot unpack spread argument into lazy parameter");
        }
        this.#put(value, name, DoargsWhere.POSITIONAL);
    }
    #put(obj: any, name: string, as: DoargsWhere) {
        const g = this.#seenByName[name];
        if (g) {
            throw new Error(`argument ${stringify(name)} already given as ${g === DoargsWhere.KEYWORD ? "keyword" : "positional"} argument`);
        }
        this.#seenByName[name] = as;
        this.#argsObj[name] = obj;
    }
    #inspect() {
        return {
            params: this.#params,
            givenArguments: this.#givenArgs,
            argsSoFar: this.#argsObj,
            givenIndex: this.#rawArgsIndex,
            parameterIndex: this.#paramsIndex,
            hasSeenKeyword: this.#seenKeyword,
        }
    }
}

const wrapLazyValue = (laziness: Laziness.LAZY | Laziness.QUOTED, given: any, env: Env) => {
    return laziness === Laziness.QUOTED ? given : new Block(env, given); // lmao Block doesn't exist yet, this is on purpose
}

export const registerDoargs = (vm: JebVM) => {
    defineOpcode(vm, "jeb:doargs", (vm, { 0: params, 1: env }) => {
        const given = vm.popData();
        // Optimization: test if it's all one rest lazy parameter, just special-case that
        const { params: { length }, rest } = params;
        if (!length && rest) {
            if (rest.lazy !== Laziness.NONE) {
                vm.pushData({ [rest.name]: wrapLazyValue(rest.lazy, given, vm.currentEnv) });
                return;
            }
        }
        vm.pushCommand("jeb:doargs/loop", new DoargsState(params, vm.currentEnv, env, given), true);
    },
        `.imm params env
.param {CallableSignature} params - the signature of the thing being called
.param {Env?} env - the closure environment that the default parameters need
.sed argslist -- argsobj
. Processes the given arguments list into the named arguments object as determined by the signature.`);
    defineOpcode(vm, "jeb:doargs/loop", (vm, { 0: state, 1: first }) => {
        wrapThrowToError(vm, "jeb:value_error", () => state.run(vm, first));
    }, null);
}

import { CallableSignature } from "../callable";
import { Env } from "../env";
import { JebVM } from "../vm";
import { defineOpcode } from "./define";

const enum DoargsWhere {
    POSITIONAL,
    KEYWORD,
}

interface DoargsState {
    readonly p: CallableSignature;
    readonly ao: Record<string, any>;
    li: number; // current index of the raw args list
    pi: number; // current index into which positional arguments are being added
    kw: boolean; // whether we have gotten our first keyword argument yet
    readonly s: Record<string, DoargsWhere>; // seen arguments by name
}

export const registerDoargs = (vm: JebVM) => {
    defineOpcode(vm, "jeb:doargs", (vm, args) => {
        const params = args[0] as CallableSignature;
        const env = args[1] as Env | undefined;
        const given = vm.popData();
        const state: DoargsState = {
            p: params,
            ao: {},
            li: 0,
            pi: 0,
            kw: false,
            s: {},
        };
        console.log({ params, env, given, state });
        throw new Error("todo doargs doargs doargs");
    },
        `.imm params env
.param {CallableSignature} params - the signature of the thing being called
.param {Env?} env - the closure environment that the default parameters need
.sed argslist -- argsobj
. Processes the given arguments list into the named arguments object as determined by the signature.`);
}

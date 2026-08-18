import { DoargsState } from "./builtins/doargs";
import { BuiltinFunction, CallableSignature, Fun } from "./callable";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { JEBError } from "./errors";
import { AccessType } from "./protocol";
import { Command } from "./vm";
import { Wrapper } from "./wrapper";

export interface JEBOpcode {
    [x: string]: unknown[];
    "jeb:tb_pop": [];
    "jeb:tb_push": [func: string, tail?: boolean];
    "jeb:shuffle": [n: number, pushIndices: number[]];
    "jeb:eval": [tail?: boolean];
    "jeb:apply": [argv: any[], tail?: boolean, noEval?: boolean];
    "jeb:doargs": [signature: CallableSignature, dynamicEnv: Env | undefined, noEval: boolean];
    "jeb:doargs/loop": [state: DoargsState, first: boolean];
    "jeb:unwrap": [flagsNotToUnwrap: string[]];
    "jeb:wrap": [cls: new (...args: any[]) => Wrapper, ...args: unknown[]];
    "jeb:apply/string-trampoline": [tail: boolean];
    "jeb:builtin/invoke": [func: BuiltinFunction];
    "jeb:index": [accessType: AccessType];
    "jeb:get": [shouldBind: boolean];
    "jeb:set": [create?: boolean, readonly?: boolean];
    "jeb:set/internal/nested": [];
    "jeb:set/internal": [valueExpr: any, returnOldValue: boolean];
    "jeb:throw": [err: JEBError];
    "jeb:with/setup": [dw: DynamicWind, varname: string | null];
    "jeb:with/install": [dw: DynamicWind];
    "jeb:with/teardown": [];
    "jeb:ffi/invokeFunction": [f: Function];
    "jeb:fn/invoke/resetEnv": [env: Env];
    "jeb:fn/invoke": [fn: Fun<any>, tailcallHint: boolean];
    "jeb:continuation/invoke": [k: Continuation];
    "jeb:if": [then: any, else_: any, isAsm?: false] | [then: Command | null, else_: Command | null, isAsm: true];
}

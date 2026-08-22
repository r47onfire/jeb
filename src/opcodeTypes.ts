import { JEBAuditEvent } from "./auditHookTypes";
import { CallableSignature, Fun, JSFun } from "./callable";
import { Continuation, DynamicWind } from "./continuation";
import { DoargsState } from "./doargs";
import { Env } from "./env";
import { JEBError } from "./errors";
import { AccessType } from "./protocol";
import { Identifier } from "./utils";
import { Command } from "./vm";
import { Wrapper } from "./wrapper";

export interface JEBOpcode {
    [x: string]: unknown[];
    // overloaded in VM
    "jeb:audit": [event: keyof JEBAuditEvent, ...args: unknown[]];
    "jeb:tb_pop": [];
    "jeb:tb_push": [func: Identifier, tail?: boolean];
    "jeb:shuffle": [n: number, pushIndices: number[]];
    "jeb:eval": [tail?: boolean];
    "jeb:apply": [argv: any[], tail?: boolean, noEval?: boolean];
    "jeb:doargs": [signature: CallableSignature, dynamicEnv: Env | undefined, noEval: boolean, funcName: Identifier | undefined];
    "jeb:doargs/loop": [state: DoargsState, first: boolean];
    "jeb:unwrap": [flagsNotToUnwrap: string[]];
    // overloaded in VM
    "jeb:wrap": [cls: new (obj: any, ...rest: unknown[]) => Wrapper, ...rest: unknown[]];
    "jeb:apply/string-trampoline": [tail: boolean];
    "jeb:builtin/invoke": [func: JSFun];
    "jeb:index": [accessType: AccessType];
    "jeb:get": [shouldBind: boolean];
    "jeb:set": [create?: boolean, readonly_?: boolean];
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

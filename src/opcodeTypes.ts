import { JEBAuditEvent } from "./auditHookTypes";
import { Block } from "./block";
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
    "jeb:tb_push": [func: Identifier, callLocation: Identifier | undefined, tail?: boolean];
    "jeb:shuffle": [n: number, pushIndices: number[]];
    "jeb:eval": [location: Identifier | undefined, tail?: boolean];
    "jeb:apply": [argv: any[], location: Identifier | undefined, tail?: boolean, noEval?: boolean];
    "jeb:doargs": [signature: CallableSignature, dynamicEnv: Env | undefined, noEval: boolean, funcName: Identifier | undefined];
    "jeb:doargs/loop": [state: DoargsState, first: boolean];
    "jeb:unwrap": [flagsNotToUnwrap: string[]];
    // overloaded in VM
    "jeb:wrap": [cls: new (obj: any, ...rest: unknown[]) => Wrapper, ...rest: unknown[]];
    "jeb:apply/id-trampoline": [tail: boolean, location: Identifier | undefined];
    "jeb:builtin/invoke": [func: JSFun, location: Identifier | undefined];
    "jeb:index": [accessType: AccessType];
    "jeb:get": [shouldBind: boolean];
    "jeb:set": [create?: boolean, readonly_?: boolean];
    "jeb:set/internal/nested": [];
    "jeb:set/internal": [valueExpr: Block, returnOldValue: boolean];
    "jeb:throw": [err: JEBError];
    "jeb:with/setup": [dw: DynamicWind, varname: Identifier | null];
    "jeb:with/install": [dw: DynamicWind];
    "jeb:with/boxprepare": [name: Identifier | null];
    "jeb:with/teardown": [];
    "jeb:ffi/invokeFunction": [f: Function];
    "jeb:fn/invoke": [fn: Fun<any>, tailcallHint: boolean];
    "jeb:continuation/invoke": [k: Continuation];
    "jeb:block/invoke": [b: Block, tail: boolean];
    "jeb:block/invoke/resetEnv": [env: Env];
    "jeb:if": [then: any, else_: any, isAsm?: false] | [then: Command | null, else_: Command | null, isAsm: true];
}

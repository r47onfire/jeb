import { BuiltinFunction, CallableSignature, Lambda } from "./callable";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { AccessType } from "./protocol";
import { Command } from "./vm";

export interface JEBOpcode {
    [x: string]: unknown[];
    "jeb:tb_pop": [];
    "jeb:tb_push": [func: string, tail?: boolean];
    "jeb:shuffle": [n: number, pushIndices: number[]];
    "jeb:eval": [tail?: boolean];
    "jeb:apply": [argv: any[], tail?: boolean];
    "jeb:doargs": [signature: CallableSignature, dynamicEnv: Env | undefined];
    "jeb:apply/string-trampoline": [tail: boolean];
    "jeb:call/builtin": [func: BuiltinFunction];
    "jeb:index/access": [];
    "jeb:index": [name: any];
    "jeb:get": [accessType: AccessType, shouldBind: boolean];
    "jeb:set": [accessType: AccessType, create: boolean, readonly: boolean];
    "jeb:set/internal/nested": [];
    "jeb:set/internal": [accessType: AccessType, valueExpr: any, returnOldValue: boolean];
    "jeb:throw": [type: string, message: string, context: Record<string, any>];
    "jeb:with/setup": [dw: DynamicWind, varname: string | null];
    "jeb:with/install": [dw: DynamicWind];
    "jeb:with/teardown": [];
    "jeb:ffi/invokeFunction": [f: Function];
    "jeb:lambda/invoke/resetEnv": [env: Env];
    "jeb:lambda/invoke": [lambda: Lambda<any>, tailcallHint: boolean];
    "jeb:continuation/invoke": [k: Continuation];
    "jeb:if": [then: any, else_: any, isAsm?: false] | [then: Command | null, else_: Command | null, isAsm: true];
}

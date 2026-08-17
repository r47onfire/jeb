import { isinstance } from "@r47onfire/game-math";
import { isString } from "lib0/function";
import { stringify } from "lib0/json";
import { add, pow } from "lib0/math";
import { Result } from "ts-res";
import { NOTHING } from "./builtins/define";
import { CallableSignature } from "./callable";
import { Env } from "./env";
import { Relation } from "./math";
import { JebVM } from "./vm";
import { Wrapper } from "./wrapper";

/**
 * Thing that can be used to match a type of an object. `true` = any
 */
export type Type = (abstract new (...args: any[]) => any) | keyof TypeMap | true;
type TypeMap = {
    string: string;
    number: number;
    boolean: boolean;
    symbol: symbol;
    undefined: undefined;
    object: Record<any, any>;
    function: (this: any, ...args: any) => any;
    bigint: bigint;
};

/**
 * Matches the object's type to the given specifier
 * @param obj The object to check
 * @param type The type specifier
 * @returns Score of the match, higher is a closer match, 0 is no match
 */
export function typeMatches(obj: any, type: Type): number {
    if (type === true) return 1;
    if (isString(type)) {
        return typeof obj === type ? 3 : 0;
    } else {
        if (!isinstance(obj, type)) return 0;
        var score = 3;
        while (type) {
            score++;
            type = Object.getPrototypeOf(type);
        }
        return score;
    }
}

export const theTypeName = (type: Type) => type === true ? "any" : isString(type) ? type : type.name;
export const typeOf = (x: any): Type => { const t = typeof x; if (t === "object" && x.constructor !== Object) return x.constructor; else return t; }

export type TypeValue<T extends Type> = T extends true ? any : T extends keyof TypeMap ? TypeMap[T] : T extends abstract new (...args: any[]) => infer U ? U : never;
export type TypeArrayValue<T extends Type[][], D extends Record<number, any>> = number extends T["length"] ? TypeValue<T[number][number]> : T extends [...infer Head extends Type[][], infer Tail extends Type[]] ? [...TypeArrayValue<Head, D>, Head["length"] extends keyof D ? D[Head["length"]] : TypeValue<Tail[number]>] : [];


export interface BaseProtocolObj<R, T extends Type[][], D extends Record<number, any>, F> {
    /**
     * The type specialization that this protocol works with.
     */
    type: T;
    run(this: unknown, vm: JebVM, args: TypeArrayValue<T, D>, flags: F): R;
    /**
     * Documentation string for this protocol implementation.
     */
    doc: string;
}
export interface DescribedProtocolObj<R, T extends Type[][], D extends Record<number, any>, I, F> extends BaseProtocolObj<R, T, D, F> {
    /**
     * Get metadata about the object. Only meaningful for the type of the first argument.
     */
    describe(this: unknown, vm: JebVM, obj: TypeValue<T[0][number]>): I;
}
export type ProtocolObj<R, T extends Type[][], D extends Record<number, any>, I, F> = I extends void ? BaseProtocolObj<R, T, D, F> : DescribedProtocolObj<R, T, D, I, F>;

export type ProtocolsList<R = unknown, T extends Type[][] = Type[][], D extends Record<number, any> = {}, I = unknown, F = unknown> = ProtocolObj<R, T, D, I, F>[];

export type BinaryProtocolToResult = ProtocolsList<Result<any, string>, [Type[], Type[]], {}, void, void>;
export type UnaryProtocolToResult = ProtocolsList<Result<any, string>, [Type[]], {}, void, void>;

export interface ApplyMetadata {
    /**
     * The name of the function to appear in tracebacks, if undefined it means it's a hidden callframe and won't show.
     */
    name: string | undefined;
    signature: CallableSignature;
    /**
     * True if the functor being called is a macro, and the result should be evaluated again in its caller's scope.
     */
    macro: boolean;
    /**
     * The environment(s) that this function closes over on order to allow default value expressions to be evaluated in that environment.
     */
    closureEnv?: Env;
}

export interface ApplyOrEvalFlags {
    tail: boolean
}

export interface AccessFlags {
    field: PropertyKey;
    type: AccessType;
}

export const enum AccessType {
    VARIABLE,
    FUNCTION,
    PROPERTY,
}

/**
 * Represents a slot that can be assigned to
 */
export abstract class Reference {
    constructor(public type: AccessType) { }
    /**
     * Returns the current value, or returns `NOTHING` and throws an error (in the VM, not Javascript) if it's not readable.
     */
    abstract get(vm: JebVM, shouldBind: boolean): any | typeof NOTHING;
    /**
     * Set the value of the slot to the provided value,
     * or throws an error if it's readonly. The stack should not be modified either way.
     */
    abstract set(vm: JebVM, value: any, createIfNotFound: boolean, makeConstant: boolean): void;
}

export interface JEBProtocols {
    [x: PropertyKey]: ProtocolsList<unknown, any, any, any, any>;
    // Runtime protocols
    apply: ProtocolsList<void, [Type[]], {}, ApplyMetadata, ApplyOrEvalFlags>;
    eval: ProtocolsList<void, [Type[]], {}, void, ApplyOrEvalFlags>;
    access: ProtocolsList<Reference | typeof NOTHING, [Type[]], {}, void, AccessFlags>;
    unwrap: ProtocolsList<void, [(typeof Wrapper)[]], {}, void, void>;
    // Math protocols
    add: BinaryProtocolToResult;
    abs: UnaryProtocolToResult;
    sub: BinaryProtocolToResult;
    neg: UnaryProtocolToResult;
    div: BinaryProtocolToResult;
    inv: UnaryProtocolToResult;
    mul: BinaryProtocolToResult;
    matMul: BinaryProtocolToResult;
    mod: BinaryProtocolToResult;
    cmp: ProtocolsList<Result<boolean, string>, [Type[], Type[], ["number"]], { 2: Relation }, void, void>;
    pow: BinaryProtocolToResult;
    bitAnd: BinaryProtocolToResult;
    bitOr: BinaryProtocolToResult;
    bitXor: BinaryProtocolToResult;
    bitNot: ProtocolsList<Result<any, string>>;
}

export type ArgcForName<N extends keyof JEBProtocols> = JEBProtocols[N] extends ProtocolsList<any, infer N, any, any> ? N["length"] : number;
export type ResultForName<N extends keyof JEBProtocols> = JEBProtocols[N] extends ProtocolsList<infer N, any, any, any> ? N : unknown;
export type FlagsForName<N extends keyof JEBProtocols> = JEBProtocols[N] extends ProtocolsList<any, any, any, any, infer N> ? N : [];
export type InfoForName<N extends keyof JEBProtocols> = JEBProtocols[N] extends ProtocolsList<any, any, any, any, infer N> ? N : never;
export type FnTypeForName<N extends keyof JEBProtocols> = JEBProtocols[N][number]["run"];

export const getProtocolHandler = (protocols: Partial<JEBProtocols>, fast: boolean, name: PropertyKey, args: any[]): ProtocolObj<any, any[], {}, any, any> | undefined => {
    const implList = protocols[name];
    if (!implList) throw new Error(`protocol ${stringify(name)} doesn't exist`);
    var bestScore = 0, bestHandler = undefined;
    handlers: for (var i = implList.length - 1; i >= 0; i--) {
        var score = 0;
        const handler = implList[i]! as ProtocolObj<any, any[], {}, any, any>;
        const type = handler.type;
        for (var j = type.length - 1; j >= 0; j--) {
            const item = args[j], typeUnion = type[j] as Type[];
            var unionSum = 0;
            for (var k = 0; k < typeUnion.length; k++) {
                unionSum += typeMatches(item, typeUnion[k]!);
            }
            if (unionSum === 0) continue handlers; // None match, this one can't be used
            score += pow(unionSum, 1 / typeUnion.length);
        }
        if (score > bestScore) {
            bestScore = score;
            bestHandler = handler;
            if (fast) break;
        }
    }
    return bestHandler;
}

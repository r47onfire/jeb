import { isinstance } from "@r47onfire/game-math";
import { isString } from "lib0/function";
import { stringify } from "lib0/json";
import { pow } from "lib0/math";
import { Result } from "ts-res";
import { NOTHING } from "./define";
import { Env } from "./env";
import { ErrnoCode } from "./errno";
import { JEBError, Location } from "./errors";
import { Relation } from "./math";
import { CallableSignature } from "./signature";
import { Identifier } from "./utils";
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
    object: Record<PropertyKey, any>;
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
export const typeOf = (x: any): Type => { const t = typeof x; if (t === "object" && x && x.constructor !== Object) return x.constructor; else return t; }

export const typecheck: <T extends Type[]>(x: unknown, t: T, paramName?: string) => asserts x is TypeValue<T[number]> = (x, t, paramName)=> {
    if (!t.some(t2 => typeMatches(x, t2))) throw new JEBError(ErrnoCode.EINVAL, `${paramName ? paramName + ": " : ""}expected ${t.map(t2 => theTypeName(t2)).join(" | ")} but got ${theTypeName(typeOf(x))}: ${x}`);
}
export const withType = <T extends Type[]>(x: unknown, t: T, paramName?: string): TypeValue<T[number]> => {
    typecheck(x, t, paramName);
    return x;
}

export type TypeValue<T extends Type> = T extends true ? any : T extends keyof TypeMap ? TypeMap[T] : T extends abstract new (...args: any[]) => infer U ? U : never;
export type TypeArrayValue<T extends Type[][], D extends Record<number, any>> = number extends T["length"] ? TypeValue<T[number][number]> : T extends [...infer Head extends Type[][], infer Tail extends Type[]] ? [...TypeArrayValue<Head, D>, Head["length"] extends keyof D ? D[Head["length"]] : TypeValue<Tail[number]>] : [];


export interface BaseProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, F> {
    /**
     * The type specialization that this protocol works with.
     */
    type: T;
    run(this: unknown, vm: V, args: TypeArrayValue<T, D>, flags: F): R;
    /**
     * Documentation string for this protocol implementation.
     */
    doc: string;
}
export interface DescribedProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, I, F> extends BaseProtocolObj<V, R, T, D, F> {
    /**
     * Get metadata about the object. Only meaningful for the type of the first argument.
     */
    describe(this: unknown, vm: V, obj: TypeValue<T[0][number]>): I;
}
export type ProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, I, F> = I extends void ? BaseProtocolObj<V, R, T, D, F> : DescribedProtocolObj<V, R, T, D, I, F>;

export type ProtocolsList<V extends JebVM, R = unknown, T extends Type[][] = Type[][], D extends Record<number, any> = {}, I = unknown, F = unknown> = ProtocolObj<V, R, T, D, I, F>[];

export type BinaryProtocolToResult<V extends JebVM> = ProtocolsList<V, Result<any, string>, [Type[], Type[]], {}, void, void>;
export type UnaryProtocolToResult<V extends JebVM> = ProtocolsList<V, Result<any, string>, [Type[]], {}, void, void>;

export interface ApplyMetadata {
    /**
     * The name of the function to appear in tracebacks, if undefined it means it's a hidden callframe and won't show.
     */
    name: Identifier | undefined;
    signature: CallableSignature;
    /**
     * The environment(s) that this function closes over on order to allow default value expressions to be evaluated in that environment.
     */
    closureEnv?: Env;
}

export interface ApplyFlags {
    tail: boolean;
    location: Location | undefined;
}

export interface EvalFlags {
    tail: boolean;
    location: Location | undefined;
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

export interface JEBProtocols<V extends JebVM> {
    [x: PropertyKey]: ProtocolsList<V, unknown, any, any, any, any>;
    // Runtime protocols
    apply: ProtocolsList<V, void, [Type[]], {}, ApplyMetadata, ApplyFlags>;
    eval: ProtocolsList<V, void, [Type[]], {}, void, EvalFlags>;
    access: ProtocolsList<V, Reference | typeof NOTHING, [Type[]], {}, void, AccessFlags>;
    unwrap: ProtocolsList<V, void, [(typeof Wrapper)[]], {}, void, void>;
    name: ProtocolsList<V, void, [Type[]], {}, void, { name: Identifier }>;
    // Math protocols
    add: BinaryProtocolToResult<V>;
    abs: UnaryProtocolToResult<V>;
    sub: BinaryProtocolToResult<V>;
    neg: UnaryProtocolToResult<V>;
    div: BinaryProtocolToResult<V>;
    inv: UnaryProtocolToResult<V>;
    mul: BinaryProtocolToResult<V>;
    matMul: BinaryProtocolToResult<V>;
    mod: BinaryProtocolToResult<V>;
    cmp: ProtocolsList<V, Result<boolean, string>, [Type[], Type[], ["number"]], { 2: Relation }, void, void>;
    pow: BinaryProtocolToResult<V>;
    bitAnd: BinaryProtocolToResult<V>;
    bitOr: BinaryProtocolToResult<V>;
    bitXor: BinaryProtocolToResult<V>;
    bitNot: ProtocolsList<V, Result<any, string>>;
}

export type ArgcForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, infer N, any, any> ? N["length"] : number;
export type ResultForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, infer N, any, any, any> ? N : unknown;
export type FlagsForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, any, any, any, infer N> ? N : [];
export type InfoForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, any, any, any, infer N> ? N : never;
export type FnTypeForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N][number]["run"];

export const getProtocolHandler = <V extends JebVM>(protocols: Partial<JEBProtocols<V>>, fast: boolean, name: PropertyKey, args: any[]): ProtocolObj<V, any, any[], {}, any, any> | undefined => {
    const implList = protocols[name];
    if (!implList) throw new JEBError(ErrnoCode.ENOSYS, `protocol ${stringify(name)} doesn't exist`);
    var bestScore = 0, bestHandler = undefined;
    handlers: for (var i = implList.length - 1; i >= 0; i--) {
        var score = 0;
        const handler = implList[i]! as ProtocolObj<V, any, any[], {}, any, any>;
        const type = handler.type;
        for (var j = type.length - 1; j >= 0; j--) {
            const item = args[j], typeUnion = type[j] as Type[], len = typeUnion.length;
            var unionSum = 0;
            for (var k = 0; k < len; k++) {
                unionSum += typeMatches(item, typeUnion[k]!);
            }
            if (unionSum === 0) continue handlers; // None match, this one can't be used
            score += pow(unionSum, 1 / len);
        }
        if (score > bestScore) {
            bestScore = score;
            bestHandler = handler;
            if (fast) break;
        }
    }
    return bestHandler;
}

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
/**
 * Maps the string type specifiers of {@link Type} to the Typescript types they match.
 */
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
        if (!(obj instanceof type)) return 0;
        var score = 3;
        while (type) {
            score++;
            type = Object.getPrototypeOf(type);
        }
        return score;
    }
}

/**
 * Human-readable name of a {@link Type} specifier, for error messages.
 */
export const theTypeName = (type: Type) => type === true ? "any" : isString(type) ? type : type.name;
/**
 * The {@link Type} specifier describing a value: its constructor, for objects
 * with a non-plain prototype, and its `typeof` string otherwise.
 */
export const typeOf = (x: any): Type => { const t = typeof x; if (t === "object" && x && x.constructor !== Object) return x.constructor; else return t; }

/**
 * Asserts that `x` matches at least one of the given types, throwing a
 * {@link JEBError} (`EINVAL`) naming `paramName` if it matches none of them.
 */
export const typecheck: <T extends Type[]>(x: unknown, t: T, paramName?: string) => asserts x is TypeValue<T[number]> = (x, t, paramName)=> {
    if (!t.some(t2 => typeMatches(x, t2))) throw new JEBError(ErrnoCode.EINVAL, `${paramName ? paramName + ": " : ""}expected ${t.map(t2 => theTypeName(t2)).join(" | ")} but got ${theTypeName(typeOf(x))}: ${x}`);
}
/**
 * Like {@link typecheck}, but returns `x` (typed as the matched type) on success.
 */
export const withType = <T extends Type[]>(x: unknown, t: T, paramName?: string): TypeValue<T[number]> => {
    typecheck(x, t, paramName);
    return x;
}

/**
 * The Typescript type of the values matched by the {@link Type} specifier `T`.
 */
export type TypeValue<T extends Type> = T extends true ? any : T extends keyof TypeMap ? TypeMap[T] : T extends abstract new (...args: any[]) => infer U ? U : never;
/**
 * Maps a list of per-argument {@link Type} unions to the tuple type of the
 * argument values. `D` may override the value type of individual positions
 * (keyed by argument index) for arguments whose value differs from the type
 * they were checked against.
 */
export type TypeArrayValue<T extends Type[][], D extends Record<number, any>> = number extends T["length"] ? TypeValue<T[number][number]> : T extends [...infer Head extends Type[][], infer Tail extends Type[]] ? [...TypeArrayValue<Head, D>, Head["length"] extends keyof D ? D[Head["length"]] : TypeValue<Tail[number]>] : [];


/**
 * A single implementation of a protocol: the argument type specialization it
 * handles, the code to run for it, and its documentation string.
 */
export interface BaseProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, F> {
    /**
     * The type specialization that this protocol works with.
     */
    type: T;
    /**
     * Runs the implementation on the given (already type-matched) arguments.
     */
    run(this: unknown, vm: V, args: TypeArrayValue<T, D>, flags: F): R;
    /**
     * Documentation string for this protocol implementation.
     */
    doc: string;
}
/**
 * A {@link BaseProtocolObj} that can also describe its first argument,
 * yielding metadata (`I`) about it, such as a callable's signature.
 */
export interface DescribedProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, I, F> extends BaseProtocolObj<V, R, T, D, F> {
    /**
     * Get metadata about the object. Only meaningful for the type of the first argument.
     */
    describe(this: unknown, vm: V, obj: TypeValue<T[0][number]>): I;
}
/**
 * A protocol implementation object: a {@link DescribedProtocolObj} if the
 * protocol has a metadata type `I`, otherwise a plain {@link BaseProtocolObj}.
 */
export type ProtocolObj<V extends JebVM, R, T extends Type[][], D extends Record<number, any>, I, F> = I extends void ? BaseProtocolObj<V, R, T, D, F> : DescribedProtocolObj<V, R, T, D, I, F>;

/**
 * All registered implementations of one protocol. When the protocol is
 * invoked, the best-matching implementation is chosen (see
 * {@link getProtocolHandler}).
 */
export type ProtocolsList<V extends JebVM, R = unknown, T extends Type[][] = Type[][], D extends Record<number, any> = {}, I = unknown, F = unknown> = ProtocolObj<V, R, T, D, I, F>[];

/**
 * A protocol taking two arguments and returning a `Result` (the binary math protocols).
 */
export type BinaryProtocolToResult<V extends JebVM> = ProtocolsList<V, Result<any, string>, [Type[], Type[]], {}, void, void>;
/**
 * A protocol taking one argument and returning a `Result` (the unary math protocols).
 */
export type UnaryProtocolToResult<V extends JebVM> = ProtocolsList<V, Result<any, string>, [Type[]], {}, void, void>;

/**
 * Metadata describing a callable, returned by the `apply` protocol's `describe`.
 */
export interface ApplyMetadata {
    /**
     * The name of the function to appear in tracebacks, if undefined it means it's a hidden callframe and won't show.
     */
    name: Identifier | undefined;
    /**
     * The callable's parameter signature, used to process its arguments.
     */
    signature: CallableSignature;
    /**
     * The environment(s) that this function closes over on order to allow default value expressions to be evaluated in that environment.
     */
    closureEnv?: Env;
}

/**
 * Flags passed to an `apply` protocol implementation for a single call.
 */
export interface ApplyFlags {
    /** Whether the call is in tail position. */
    tail: boolean;
    /** Source location of the call site, for tracebacks. */
    location: Location | undefined;
}

/**
 * Flags passed to an `eval` protocol implementation for a single evaluation.
 */
export interface EvalFlags {
    /** Whether the evaluation is in tail position. */
    tail: boolean;
    /** Source location of the expression being evaluated, for tracebacks. */
    location: Location | undefined;
}

/**
 * Flags passed to an `access` protocol implementation: which field of the
 * object to access, and in what capacity.
 */
export interface AccessFlags {
    /** The field (variable name, property key, ...) being accessed. */
    field: PropertyKey;
    /** The capacity in which the field is accessed. */
    type: AccessType;
}

/**
 * The capacity in which a {@link Reference} is accessed.
 */
export const enum AccessType {
    VARIABLE,
    FUNCTION,
    PROPERTY,
}

/**
 * Represents a slot that can be assigned to
 */
export abstract class Reference {
    constructor(readonly type: AccessType) { }
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

/**
 * The protocol registry of a VM: maps each protocol name to the list of its
 * registered implementations. The runtime protocols (`apply`, `eval`,
 * `access`, `unwrap`, `name`) drive evaluation; the rest implement the
 * overloadable math operations.
 */
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

/**
 * The number of arguments the protocol `N` takes.
 */
export type ArgcForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, infer N, any, any> ? N["length"] : number;
/**
 * The result type of the protocol `N`.
 */
export type ResultForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, infer N, any, any, any> ? N : unknown;
/**
 * The flags type passed to implementations of the protocol `N`.
 */
export type FlagsForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, any, any, any, infer N> ? N : [];
/**
 * The metadata type (`describe` result) of the protocol `N`.
 */
export type InfoForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N] extends ProtocolsList<V, any, any, any, any, infer N> ? N : never;
/**
 * The `run` function type of implementations of the protocol `N`.
 */
export type FnTypeForName<V extends JebVM, N extends keyof JEBProtocols<V>> = JEBProtocols<V>[N][number]["run"];

/**
 * Selects the implementation of the protocol `name` to use for the given
 * arguments. Each registered implementation is scored by how specifically its
 * argument types match (see {@link typeMatches}); the highest score wins,
 * with later registrations preferred over earlier ones with the same score.
 * If `fast` is set, the first (most recently registered) implementation that
 * matches at all is used instead of searching for the best-scoring one.
 *
 * @returns the chosen implementation, or `undefined` if none of them matches
 * @throws A {@link JEBError} (`ENOSYS`) if the protocol itself doesn't exist
 */
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

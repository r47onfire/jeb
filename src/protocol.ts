import { pow } from "lib0/math";
import { Result } from "ts-res";
import { Block } from "./block";
import { NOTHING } from "./define";
import { Env } from "./env";
import { Location } from "./errors";
import { Relation } from "./math";
import { CallableSignature } from "./signature";
import {
    isPlainObject,
    predicateToClass,
    Type,
    TypeMap,
    typeMatches,
} from "./typecheck";
import { Identifier } from "./utils";
import { JebVM } from "./vm";
import { PROTOCOL_SYMBOLS, ProtocolSymbolName } from "./well_known";
import { Wrapper } from "./wrapper";

/** The Typescript type of the values matched by the {@link Type} specifier `T`. */
export type TypeValue<T extends Type> = T extends true
    ? any
    : T extends keyof TypeMap
      ? TypeMap[T]
      : T extends abstract new (...args: any[]) => infer U
        ? U
        : never;
/**
 * Maps a list of per-argument {@link Type} unions to the tuple type of the
 * argument values. `D` may override the value type of individual positions
 * (keyed by argument index) for arguments whose value differs from the type
 * they were checked against.
 */
export type TypeArrayValue<
    T extends Type[][],
    D extends Record<number, any>,
> = number extends T["length"]
    ? TypeValue<T[number][number]>
    : T extends [...infer Head extends Type[][], infer Tail extends Type[]]
      ? [
            ...TypeArrayValue<Head, D>,
            Head["length"] extends keyof D
                ? D[Head["length"]]
                : TypeValue<Tail[number]>,
        ]
      : [];

/**
 * A single implementation of a protocol: the argument type specialization it
 * handles, the code to run for it, and its documentation string.
 */
export interface BaseProtocolObj<
    V extends JebVM,
    R,
    T extends Type[][],
    D extends Record<number, any>,
    F,
> {
    /** The type specialization that this protocol works with. */
    type: T;
    /** Runs the implementation on the given (already type-matched) arguments. */
    run(this: unknown, vm: V, args: TypeArrayValue<T, D>, flags: F): R;
    /** Documentation string for this protocol implementation. */
    doc: string;
}
/**
 * A {@link BaseProtocolObj} that can also describe its first argument, yielding
 * metadata (`I`) about it, such as a callable's signature.
 */
export interface DescribedProtocolObj<
    V extends JebVM,
    R,
    T extends Type[][],
    D extends Record<number, any>,
    I,
    F,
> extends BaseProtocolObj<V, R, T, D, F> {
    /**
     * Get metadata about the object. Only meaningful for the type of the first
     * argument.
     */
    describe(this: unknown, vm: V, obj: TypeValue<T[0][number]>): I;
}
/**
 * A protocol implementation object: a {@link DescribedProtocolObj} if the
 * protocol has a metadata type `I`, otherwise a plain {@link BaseProtocolObj}.
 */
export type ProtocolObj<
    V extends JebVM,
    R,
    T extends Type[][],
    D extends Record<number, any>,
    I,
    F,
> = I extends void
    ? BaseProtocolObj<V, R, T, D, F>
    : DescribedProtocolObj<V, R, T, D, I, F>;

/**
 * All registered implementations of one protocol. When the protocol is invoked,
 * the best-matching implementation is chosen (see {@link getProtocolHandler}).
 */
export type ProtocolsList<
    V extends JebVM,
    R = unknown,
    T extends Type[][] = Type[][],
    D extends Record<number, any> = {},
    I = unknown,
    F = unknown,
> = ProtocolObj<V, R, T, D, I, F>[];

/**
 * A protocol taking two arguments and returning a `Result` (the binary math
 * protocols).
 */
export type BinaryProtocolToResult<V extends JebVM> = ProtocolsList<
    V,
    Result<any, string>,
    [Type[], Type[]],
    {},
    void,
    void
>;
/**
 * A protocol taking one argument and returning a `Result` (the unary math
 * protocols).
 */
export type UnaryProtocolToResult<V extends JebVM> = ProtocolsList<
    V,
    Result<any, string>,
    [Type[]],
    {},
    void,
    void
>;

/**
 * Metadata describing a callable, returned by the `apply` protocol's
 * `describe`.
 */
export interface ApplyMetadata {
    /**
     * The name of the function to appear in tracebacks, if undefined it means
     * it's a hidden callframe and won't show.
     */
    name: Identifier | undefined;
    /** The callable's parameter signature, used to process its arguments. */
    signature: CallableSignature;
    /**
     * The environment(s) that this function closes over on order to allow
     * default value expressions to be evaluated in that environment.
     */
    closureEnv?: Env;
}

/** Flags passed to an `apply` protocol implementation for a single call. */
export interface ApplyFlags {
    /** Whether the call is in tail position. */
    tail: boolean;
    /** Source location of the call site, for tracebacks. */
    location: Location | undefined;
}

/** Flags passed to an `eval` protocol implementation for a single evaluation. */
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

/** Flags passed to a `get` protocol implementation for a single read. */
export interface GetFlags {
    /** Whether a lazy binding is bound (evaluated) by the read. */
    shouldBind: boolean;
}

/** Flags passed to a `set` protocol implementation for a single assignment. */
export interface SetFlags {
    /** Whether the slot is created if it doesn't exist yet. */
    create: boolean;
    /** Whether the slot becomes read-only. */
    readonly: boolean;
    /**
     * The value argument is an unevaluated `Block` (the `assign` builtin's
     * right-hand side): the implementation arranges its evaluation, with `_`
     * bound to the old value, unless the assignment target's own signature
     * takes it unevaluated. Absent for the `assign` opcode, whose value is
     * already computed.
     */
    unevaluated?: boolean;
    /** With `unevaluated`: the assignment's result is the old value. */
    old?: boolean;
}

/** The capacity in which a {@link Reference} is accessed. */
export const enum AccessType {
    VARIABLE,
    FUNCTION,
    PROPERTY,
}

/** Represents a slot that can be assigned to */
export abstract class Reference {
    constructor(readonly type: AccessType) {}
    /**
     * Returns the current value, or returns `NOTHING` and throws an error (in
     * the VM, not Javascript) if it's not readable.
     */
    abstract get(vm: JebVM, shouldBind: boolean): any | typeof NOTHING;
    /**
     * Set the value of the slot to the provided value, or throws an error if
     * it's readonly. The stack should not be modified either way.
     */
    abstract set(
        vm: JebVM,
        value: any,
        createIfNotFound: boolean,
        makeConstant: boolean,
    ): void;
}

/**
 * The protocol registry of a VM: maps each protocol name to the list of its
 * registered implementations. The runtime protocols (`apply`, `eval`, `access`,
 * `get`, `set`, `unwrap`, `name`) drive evaluation; the rest implement the
 * overloadable math operations.
 */
export interface JEBProtocols<V extends JebVM> {
    [x: PropertyKey]: ProtocolsList<V, unknown, any, any, any, any>;
    // Runtime protocols
    apply: ProtocolsList<V, void, [Type[]], {}, ApplyMetadata, ApplyFlags>;
    eval: ProtocolsList<V, void, [Type[]], {}, void, EvalFlags>;
    access: ProtocolsList<
        V,
        Reference | typeof NOTHING,
        [Type[]],
        {},
        void,
        AccessFlags
    >;
    get: ProtocolsList<V, any, [Type[]], {}, void, GetFlags>;
    set: ProtocolsList<V, void, [Type[], Type[]], {}, void, SetFlags>;
    unwrap: ProtocolsList<V, void, [(typeof Wrapper)[]], {}, string, void>;
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
    cmp: ProtocolsList<
        V,
        Result<boolean, string>,
        [Type[], Type[], ["number"]],
        { 2: Relation },
        void,
        void
    >;
    pow: BinaryProtocolToResult<V>;
    bitAnd: BinaryProtocolToResult<V>;
    bitOr: BinaryProtocolToResult<V>;
    bitXor: BinaryProtocolToResult<V>;
    shl: BinaryProtocolToResult<V>;
    shr: BinaryProtocolToResult<V>;
    bitNot: ProtocolsList<V, Result<any, string>>;
}

/**
 * Returns the protocol method that `obj` itself provides for the protocol
 * `name`: the callable stored on the object under the protocol's symbol, or
 * `undefined` if the object doesn't provide one.
 */
export const protocolMethod = (
    obj: any,
    name: ProtocolSymbolName,
): any | undefined => {
    if (!isPlainObject(obj)) return undefined;
    return obj[PROTOCOL_SYMBOLS[name]];
};

/**
 * A reference to a property of an object that provides an `__access__` protocol
 * method. The method has not been called yet: the key is kept as the
 * unevaluated {@link Block} it arrived as, so when the reference is read or
 * assigned, the `get` / `assign` opcodes can pass the key expression straight
 * to `__access__` and let the method's signature decide whether it is
 * evaluated. The method returns a descriptor object whose own `__get__` /
 * `__set__` methods the access then goes through. (An object that wants to be
 * its own descriptor returns itself from `__access__`; `__get__` / `__set__`
 * methods alone do not make an object indexable.)
 *
 * The synchronous accessors throw: all real access goes through the opcodes,
 * which call the methods.
 */
export class AccessReference {
    constructor(
        readonly obj: any,
        readonly key: Block,
    ) {}
    /**
     * The name of the property being accessed, when the key is a literal
     * string, number or symbol; used in error messages. A computed key
     * expression has no static name.
     */
    get propertyName(): string | undefined {
        const form = this.key.body[0];
        switch (typeof form) {
            case "string":
                return form;
            case "number":
            case "symbol":
                return String(form);
            default:
                return undefined;
        }
    }
}

/** The number of arguments the protocol `N` takes. */
/**
 * Pseudoclass matching the values that are wrappers by providing the two
 * wrapper properties: a `__tag__` (their tag, as a plain property -- a tag is
 * never computed, so reading it is synchronous) and a `__unwrap__` method.
 * References are read and assigned, never unwrapped, so they do not match.
 */
export const Unwrappable = predicateToClass(
    (x): x is Record<PropertyKey, any> =>
        isPlainObject(x) &&
        Reflect.has(x, PROTOCOL_SYMBOLS.tag) &&
        Reflect.has(x, PROTOCOL_SYMBOLS.unwrap),
);

export type ArgcForName<V extends JebVM, N extends keyof JEBProtocols<V>> =
    JEBProtocols<V>[N] extends ProtocolsList<V, any, infer N, any, any>
        ? N["length"]
        : number;

/**
 * Selects the implementation of the protocol `name` to use for the given
 * arguments. Each registered implementation is scored by how specifically its
 * argument types match (see {@link typeMatches}); the highest score wins, with
 * later registrations preferred over earlier ones with the same score. If
 * `fast` is set, the first (most recently registered) implementation that
 * matches at all is used instead of searching for the best-scoring one.
 *
 * @returns The chosen implementation, or `undefined` if none of them matches
 *   (or if the protocol has no implementations registered at all)
 */
export const getProtocolHandler = <V extends JebVM>(
    protocols: Partial<JEBProtocols<V>>,
    fast: boolean,
    name: PropertyKey,
    args: any[],
): ProtocolObj<V, any, any[], {}, any, any> | undefined => {
    const implList = protocols[name];
    if (!implList) return undefined;
    var bestScore = 0,
        bestHandler = undefined;
    handlers: for (var i = implList.length - 1; i >= 0; i--) {
        var score = 0;
        const handler = implList[i]! as ProtocolObj<
            V,
            any,
            any[],
            {},
            any,
            any
        >;
        const type = handler.type;
        for (var j = type.length - 1; j >= 0; j--) {
            const item = args[j],
                typeUnion = type[j] as Type[],
                len = typeUnion.length;
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
};

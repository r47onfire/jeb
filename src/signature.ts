import { isArray } from "lib0/array";
import { stringify } from "lib0/json";
import { ErrnoCode } from "./errno";
import { JEBError } from "./errors";
import { Identifier, UnionPermutations, Writable, isIdentifier } from "./utils";
import { isNumber } from "lib0/function";


/**
 * Compact form of one parameter in a callable signature. Each union member is
 * a different parameter flavour (the members are documented individually);
 * {@link createSignature} converts an array of these into the
 * {@link LonghandArgument} form used at runtime. In a parameter tuple the
 * option slots may appear in any order before the name; the slot's type
 * says what it is (array: flags, boolean: laziness, number: rest kind,
 * plain object: named options), and at most one slot -- the default --
 * may follow the name.
 */
export type ShorthandArgument<N extends Identifier = Identifier, R extends 0 | 1 | undefined = undefined> =
    /**
     * param gets evaluated and unwrapped, no default
     */
    | N
    /**
     * parameter with all the possible flags & default
     */
    | [...UnionPermutations<
        | R // 0/1, if present, corresponds to rest positional/keyword
        | boolean // if present, laziness
        | string[] // flags not to unwrap
        | Record<string, any>,
        1 | 2 | 3 | 4>, N, default_?: any]

/**
 * How a parameter's argument expression is treated when the callable is invoked.
 */
export const enum Laziness {
    /** The argument is evaluated (and unwrapped) before the body runs. */
    NONE,
    /** The argument is wrapped in a block without being evaluated. */
    LAZY,
    /** The argument is passed as the raw, unevaluated expression. */
    QUOTED
}

/**
 * How the parameter accepts arguments.
 */
export const enum Rest {
    /** A normal parameter, can be positional or keyword. */
    NONE,
    /** A positional rest argument that receives all the remaining positional arguments. */
    POSITIONAL,
    /** A keyword rest argument that receives all the unmatched keyword arguments. */
    KEYWORD,
}

/**
 * One parameter of a callable signature, in the expanded form produced by
 * {@link createSignature} and consumed by the argument-processing machinery.
 */
export interface LonghandArgument<N extends Identifier, R extends 0 | 1 | undefined = undefined> {
    /** The parameter's name. */
    readonly name: N;
    /** Whether the caller must supply the argument. Ignored if {@link rest} is not {@link Rest.NONE}. */
    readonly required: R extends 0 | 1 ? false : boolean;
    /** Expression evaluated to produce the value when the argument is not supplied; only meaningful if the parameter is not `required`. */
    readonly defaultExpr: R extends 0 ? any[] : R extends 1 ? Record<string, any> : any;
    /** Whether (and how) the argument expression is deferred; see {@link Laziness}. */
    readonly lazy: Laziness;
    /** Names of wrappers that are *not* unwrapped from this parameter's value, so the body can operate on the wrapper itself. */
    readonly flags: string[];
    /** Whether the parameter is a rest parameter. */
    readonly rest: R extends undefined ? Rest.NONE : R extends 0 ? Rest.POSITIONAL : R extends 1 ? Rest.KEYWORD : Rest;
    /** Named enum options. */
    readonly options: Record<string, any>;
}

/**
 * Type-level conversion of one shorthand parameter into its
 * {@link LonghandArgument}, since Typescript is too stupid to be able to
 * infer directly from {@link ShorthandArgument}. The tuple is walked one slot
 * at a time, the same way {@link createSignature} walks it at runtime: option
 * slots are recognized by their type (array: flags, boolean: laziness, number:
 * rest kind, plain object: named options) and skipped, the identifier slot is
 * the parameter's name, and anything after the name is the default and is
 * ignored.
 */
type ShorthandParamToLonghand<T, R extends 0 | 1 | undefined = undefined> =
    T extends Identifier ? LonghandArgument<T, R>
    : T extends readonly [infer H, ...infer Rest]
    ? H extends Identifier ? LonghandArgument<H, R>
    : H extends 0 | 1 ? ShorthandParamToLonghand<Rest, H>
    : ShorthandParamToLonghand<Rest, R>
    : LonghandArgument<Identifier, R>;

/**
 * Type-level expansion of a shorthand signature's parameters into
 * {@link LonghandArgument}s.
 */
export type ShorthandToLonghand<S extends readonly ShorthandArgument<any, any>[]> = S extends readonly [infer P, ...infer T extends readonly any[]] ? [ShorthandParamToLonghand<P>, ...ShorthandToLonghand<T>] : readonly [];

export type CallableSignature<P extends readonly LonghandArgument<any, any>[] = readonly LonghandArgument<any, any>[]> = P;

/**
 * The {@link CallableSignature} that {@link createSignature} produces for the
 * shorthand signature `S`, computed at the type level.
 */
export type CallableSignatureFromShorthand<S extends readonly ShorthandArgument<any, any>[]> = CallableSignature<ShorthandToLonghand<S>>;

declare const x: CallableSignatureFromShorthand<[[false, "onchange"], [["ref"], 0, "refs"]]>;

/**
 * Converts a shorthand signature into its {@link CallableSignature} longhand
 * form, validating it in the process.
 *
 * @throws A {@link JEBError} (`ESYNTAX` or `EEXIST`) if the signature is malformed, e.g.
 * a rest parameter has a default or a parameter name is duplicated.
 */
export const createSignature = <const S extends readonly ShorthandArgument<any, any>[]>(signature: S): CallableSignatureFromShorthand<S> => {
    const processed: Writable<CallableSignature> = [];
    const len = signature.length;
    // console.log("START", signature);
    for (var i = 0; i < len; i++) {
        const arg = signature[i]!;
        var name: Identifier | undefined = undefined, required = true, defaultExpr, lazy = Laziness.NONE, rest = Rest.NONE, flags: string[] = [], options = {};
        if (isIdentifier(arg)) {
            name = arg;
            // console.log("simple name", arg);
        } else {
            for (var j = 0; j < arg.length; j++) {
                const x = arg[j]!;
                // console.log("arg part", x);
                // if (name !== undefined && !required) {
                //     throw new JEBError(ErrnoCode.ESYNTAX, "unexpected junk after default expression");
                // } else
                if (name !== undefined) {
                    defaultExpr = x;
                    required = false;
                    // console.log("-> default");
                } else if (isArray(x)) {
                    flags = x;
                    // console.log("-> flags");
                } else if (typeof x === "boolean") {
                    lazy = x ? Laziness.QUOTED : Laziness.LAZY;
                    // console.log("-> laziness");
                } else if (isNumber(x)) {
                    rest = x === 0 ? Rest.POSITIONAL : Rest.KEYWORD;
                    // console.log("-> rest");
                } else if (isIdentifier(x)) {
                    name = x;
                    // console.log("-> name");
                } else if (typeof x === "object") {
                    options = x;
                    // console.log("-> options");
                } else {
                    throw new JEBError(ErrnoCode.ESYNTAX, "unexpected junk in param spec");
                }
            }
            if (name === undefined) {
                throw new JEBError(ErrnoCode.ESYNTAX, "arg name not found at position " + i);
            }
        }
        const assembledArg: Writable<LonghandArgument<Identifier, 0 | 1 | undefined>> = { name, required, defaultExpr, lazy, flags, rest, options };
        if (processed.some(x => x.name === name)) {
            throw new JEBError(ErrnoCode.EEXIST, `duplicate parameter ${String(name)}`);
        }
        if (!required && rest !== Rest.NONE) {
            throw new JEBError(ErrnoCode.ESYNTAX, `argument ${String(name)} cannot have a default as it is a ${rest === Rest.POSITIONAL ? "" : "keyword "}rest argument`);
        }
        if (lazy !== Laziness.NONE && rest === Rest.KEYWORD) {
            throw new JEBError(ErrnoCode.ESYNTAX, `keyword rest param cannot be lazy`);
        }
        if (rest !== Rest.NONE) assembledArg.required = false;
        processed.push(assembledArg);
        // console.log(assembledArg);
    }
    // console.log("DONE", processed);
    return processed as any;
};

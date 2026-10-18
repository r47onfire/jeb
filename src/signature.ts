import { isArray } from "lib0/array.js";
import { stringify } from "lib0/json.js";
import { JEBError } from "./errors";
import { Identifier, Writable, isIdentifier } from "./utils";
import { ErrnoCode } from "./errno";


/**
 * Compact form of one parameter in a callable signature. Each union member is
 * a different parameter flavour (the members are documented individually);
 * {@link createSignature} converts an array of these into the
 * {@link LonghandArgument} form used at runtime. A bare `true`/`false` is not
 * a parameter itself: it marks the preceding parameter as a rest parameter.
 */
export type ShorthandArgument<N extends Identifier = Identifier, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> =
    /**
     * param gets evaluated and unwrapped, no default
     */
    | N
    /**
     * param gets evaluated, optional with dynamically scoped default
     */
    | readonly [name: N, defaultExpr: any]
    /**
     * lazy param (wrapped in block rather than evaluated), required
     */
    | readonly [lazy: false, name: N]
    /**
     * code param (quoted - unevaluated and not wrapped in a block either)
     */
    | readonly [macro: true, name: N]
    /**
     * flagged param (evaluated, named flag types are not unwrapped)
     */
    | readonly [flags: F, name: N]
    /**
     * flagged param with default
     */
    | readonly [flags: F, name: N, defaultExpr: any]
    /**
     * flagged block param with default (block will have flags to not unwrap at end)
     */
    | readonly [flags: F, lazy: false, name: N]
    /**
     * previous argument is a rest argument and receives all the other positional arguments
     */
    | true
    /**
     * previous argument is a kw rest argument and receives all the other keyword arguments
     */
    | false;

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
 * One parameter of a callable signature, in the expanded form produced by
 * {@link createSignature} and consumed by the argument-processing machinery.
 */
export interface LonghandArgument<N extends Identifier, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> {
    /** The parameter's name. */
    readonly name: N;
    /** Whether the caller must supply the argument. */
    readonly required: boolean;
    /** Expression evaluated to produce the value when the argument is not supplied; only meaningful if the parameter is not `required`. */
    readonly defaultExpr: any;
    /** Whether (and how) the argument expression is deferred; see {@link Laziness}. */
    readonly lazy: Laziness;
    /** Names of wrappers that are *not* unwrapped from this parameter's value, so the body can operate on the wrapper itself. */
    readonly flags: F;
}
/**
 * Type-level expansion of a shorthand signature's parameters into
 * {@link LonghandArgument}s, dropping the `true`/`false` rest markers.
 */
export type ShorthandToLonghand<S extends readonly ShorthandArgument<any, any>[]> = S extends readonly [ShorthandArgument<any, any>, boolean, ...infer T extends readonly any[]] ? ShorthandToLonghand<T> : S extends readonly [ShorthandArgument<infer N, infer F>, ...infer T extends readonly any[]] ? [LonghandArgument<N, F>, ...ShorthandToLonghand<T>] : readonly [];
/**
 * Type-level extraction of a rest parameter (the parameter followed by `B`:
 * `true` for the positional rest parameter, `false` for the keyword one)
 * from a shorthand signature, or `undefined` if there is none.
 */
export type ExtractRest<S extends readonly (ShorthandArgument<any, any> | boolean)[], B extends boolean> = S extends readonly [ShorthandArgument<infer N, infer F>, B, ...readonly any[]] ? LonghandArgument<N, F> : S extends readonly [any, ...infer R extends readonly ShorthandArgument<any, any>[]] ? ExtractRest<R, B> : undefined;

/**
 * The full signature of a callable: its positional parameters plus its
 * optional rest parameters.
 */
export interface CallableSignature<P extends readonly LonghandArgument<any, any>[] = readonly LonghandArgument<any, any>[], R extends LonghandArgument<any, any> | undefined = LonghandArgument<any, any> | undefined, K extends LonghandArgument<any, any> | undefined = LonghandArgument<any, any> | undefined> {
    /** The positional parameters, in order. */
    readonly params: P;
    /** The parameter receiving all remaining positional arguments, if any. */
    readonly rest: R;
    /** The parameter receiving all remaining keyword arguments, if any. */
    readonly kwRest: K;
}

/**
 * The {@link CallableSignature} that {@link createSignature} produces for the
 * shorthand signature `S`, computed at the type level.
 */
export type CallableSignatureFromShorthand<S extends readonly ShorthandArgument<any, any>[]> = CallableSignature<ShorthandToLonghand<S>, ExtractRest<S, true>, ExtractRest<S, false>>;

declare const x: CallableSignatureFromShorthand<[[false, "onchange"], [["ref"], "refs"], true]>;

/**
 * Converts a shorthand signature into its {@link CallableSignature} longhand
 * form, validating it in the process.
 *
 * @throws A {@link JEBError} (`ESYNTAX`) if the signature is malformed, e.g.
 * a required parameter follows an optional one, a rest parameter has a
 * default, is duplicated, or is followed by further parameters.
 */
export const createSignature = <const S extends readonly ShorthandArgument<any, any>[]>(signature: S): CallableSignatureFromShorthand<S> => {
    const processed: Writable<CallableSignature<any, any, any>> = {
        params: [],
        rest: undefined,
        kwRest: undefined,
    };
    var seenOptional = false;
    const len = signature.length;
    for (var i = 0; i < len; i++) {
        const arg = signature[i]! as ShorthandArgument<string, string[]>;
        const next = signature[i + 1]! as ShorthandArgument<string, string[]>;
        var name: string, required = true, defaultExpr, lazy = Laziness.NONE, flags: string[] = [], j = 0;
        if (isIdentifier(arg)) {
            name = arg;
        } else {
            if (typeof arg === "boolean") throw new JEBError(ErrnoCode.ESYNTAX, `invalid boolean flag at position ${i}`);
            const len = arg.length;
            if (isArray(arg[j])) flags = arg[j++] as string[];
            if (typeof arg[j] === "boolean") lazy = arg[j++] ? Laziness.QUOTED : Laziness.LAZY;
            if (!isIdentifier(arg[j])) {
                throw new JEBError(ErrnoCode.ESYNTAX, `arg name not found at position ${i}`);
            }
            name = arg[j++] as string;
            if (j < len) {
                required = false;
                defaultExpr = arg[j++];
            }
            if (j < len) throw new JEBError(ErrnoCode.ESYNTAX, "unexpected junk after default expression");
        }
        if (!required) seenOptional = true;
        else if (seenOptional) throw new JEBError(ErrnoCode.ESYNTAX, `required parameter ${stringify(name)} cannot follow optional parameter`);
        const assembledArg: Writable<LonghandArgument<string, string[]>> = { name, required, defaultExpr, lazy, flags };
        if (typeof next === "boolean") {
            if (!required) throw new JEBError(ErrnoCode.ESYNTAX, `argument ${stringify(name)} cannot have a default as it is a ${next ? "" : "keyword "}rest argument`);
            assembledArg.required = false;
            if (next) {
                if (processed.rest !== undefined) throw new JEBError(ErrnoCode.ESYNTAX, `duplicate rest argument ${stringify(name)} (${stringify(processed.rest.name)} already exists)`);
                processed.rest = assembledArg;
            } else {
                if (lazy !== Laziness.NONE) throw new JEBError(ErrnoCode.ESYNTAX, `keyword rest param cannot be lazy`);
                if (processed.kwRest !== undefined) throw new JEBError(ErrnoCode.ESYNTAX, `duplicate keyword rest argument ${stringify(name)} (${stringify(processed.kwRest.name)} already exists)`);
                processed.kwRest = assembledArg;
            }
            i++;
        } else {
            if (processed.rest !== undefined) throw new JEBError(ErrnoCode.ESYNTAX, `rest arg ${stringify(processed.rest.name)} must not have non-rest arguments after it`);
            if (processed.kwRest !== undefined) throw new JEBError(ErrnoCode.ESYNTAX, `keyword rest arg ${stringify(processed.kwRest.name)} must not have non-rest arguments after it`);
            processed.params.push(assembledArg);
        }
    }
    return processed;
};

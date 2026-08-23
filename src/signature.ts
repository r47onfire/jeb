import { isArray } from "lib0/array.js";
import { stringify } from "lib0/json.js";
import { JEBSyntaxError } from "./errors";
import { Identifier, Writable, isIdentifier } from "./utils";


export type ShorthandArgument<N extends Identifier = Identifier, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> =
    /**
     * param gets evaluated and unwrapped, no default
     */
    N
    /**
     * param gets evaluated, optional with dynamically scoped default
     */
    |



    readonly [name: N, defaultExpr: any]
    /**
     * lazy param (wrapped in block rather than evaluated), required
     */
    |



    readonly [lazy: false, name: N]
    /**
     * code param (quoted - unevaluated and not wrapped in a block either)
     */
    |



    readonly [macro: true, name: N]
    /**
     * flagged param (evaluated, named flag types are not unwrapped)
     */
    |



    readonly [flags: F, name: N]
    /**
     * flagged param with default
     */
    |



    readonly [flags: F, name: N, defaultExpr: any]
    /**
     * flagged block param with default (block will have flags to not unwrap at end)
     */
    |



    readonly [flags: F, lazy: false, name: N]
    /**
     * previous argument is a rest argument and receives all the other positional arguments
     */
    |



    true
    /**
     * previous argument is a kw rest argument and receives all the other keyword arguments
     */
    |



    false;

export const enum Laziness {
    NONE,
    LAZY,
    QUOTED
}

export interface LonghandArgument<N extends Identifier, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> {
    readonly name: N;
    readonly required: boolean;
    readonly defaultExpr: any;
    readonly lazy: Laziness;
    readonly flags: F;
}
export type ShorthandToLonghand<S extends readonly ShorthandArgument<any, any>[]> = S extends readonly [ShorthandArgument<any, any>, boolean, ...infer T extends readonly any[]] ? ShorthandToLonghand<T> : S extends readonly [ShorthandArgument<infer N, infer F>, ...infer T extends readonly any[]] ? [LonghandArgument<N, F>, ...ShorthandToLonghand<T>] : readonly [];
export type ExtractRest<S extends readonly (ShorthandArgument<any, any> | boolean)[], B extends boolean> = S extends readonly [ShorthandArgument<infer N, infer F>, B, ...readonly any[]] ? LonghandArgument<N, F> : S extends readonly [any, ...infer R extends readonly ShorthandArgument<any, any>[]] ? ExtractRest<R, B> : undefined;

export interface CallableSignature<P extends readonly LonghandArgument<any, any>[] = readonly LonghandArgument<any, any>[], R extends LonghandArgument<any, any> | undefined = LonghandArgument<any, any> | undefined, K extends LonghandArgument<any, any> | undefined = LonghandArgument<any, any> | undefined> {
    readonly params: P;
    readonly rest: R;
    readonly kwRest: K;
}

export type CallableSignatureFromShorthand<S extends readonly ShorthandArgument<any, any>[]> = CallableSignature<ShorthandToLonghand<S>, ExtractRest<S, true>, ExtractRest<S, false>>;

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
            if (typeof arg === "boolean") throw new JEBSyntaxError(`invalid boolean flag at position ${i}`);
            const len = arg.length;
            if (isArray(arg[j])) flags = arg[j++] as string[];
            if (typeof arg[j] === "boolean") lazy = arg[j++] ? Laziness.QUOTED : Laziness.LAZY;
            if (!isIdentifier(arg[j])) {
                throw new JEBSyntaxError(`arg name not found at position ${i}`);
            }
            name = arg[j++] as string;
            if (j < len) {
                required = false;
                defaultExpr = arg[j++];
            }
            if (j < len) throw new JEBSyntaxError("unexpected junk after default expression");
        }
        if (!required) seenOptional = true;
        else if (seenOptional) throw new JEBSyntaxError(`required parameter ${stringify(name)} cannot follow optional parameter`);
        const assembledArg: Writable<LonghandArgument<string, string[]>> = { name, required, defaultExpr, lazy, flags };
        if (typeof next === "boolean") {
            if (!required) throw new JEBSyntaxError(`argument ${stringify(name)} cannot have a default as it is a ${next ? "" : "keyword "}rest argument`);
            assembledArg.required = false;
            if (next) {
                if (processed.rest !== undefined) throw new JEBSyntaxError(`duplicate rest argument ${stringify(name)} (${stringify(processed.rest.name)} already exists)`);
                processed.rest = assembledArg;
            } else {
                if (lazy !== Laziness.NONE) throw new JEBSyntaxError(`keyword rest param cannot be lazy`);
                if (processed.kwRest !== undefined) throw new JEBSyntaxError(`duplicate keyword rest argument ${stringify(name)} (${stringify(processed.kwRest.name)} already exists)`);
                processed.kwRest = assembledArg;
            }
            i++;
        } else {
            if (processed.rest !== undefined) throw new JEBSyntaxError(`rest arg ${stringify(processed.rest.name)} must not have non-rest arguments after it`);
            if (processed.kwRest !== undefined) throw new JEBSyntaxError(`keyword rest arg ${stringify(processed.kwRest.name)} must not have non-rest arguments after it`);
            processed.params.push(assembledArg);
        }
    }
    return processed;
};

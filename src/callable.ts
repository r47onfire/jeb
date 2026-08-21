import { isArray } from "lib0/array";
import { isString } from "lib0/function";
import { stringify } from "lib0/json";
import { type HasDocstring } from "./doc";
import { Env } from "./env";
import { Writable } from "./utils";
import { JebVM } from "./vm";
import { JEBStateError, JEBSyntaxError } from "./errors";

const setPrototypeOf = Object.setPrototypeOf;

export type ShorthandArgument<N extends string = string, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> =
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
    | false
    ;

export const enum Laziness {
    NONE,
    LAZY,
    QUOTED,
}

export interface LonghandArgument<N extends string, F extends readonly (string | boolean)[] = readonly (string | boolean)[]> {
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

export type CallableSignatureFromShorthand<S extends readonly ShorthandArgument<any, any>[]> = CallableSignature<ShorthandToLonghand<S>, ExtractRest<S, true>, ExtractRest<S, false>>

export const createSignature = <const S extends readonly ShorthandArgument<any, any>[]>(signature: S): CallableSignatureFromShorthand<S> => {
    const processed: Writable<CallableSignature<any, any, any>> = {
        params: [],
        rest: undefined,
        kwRest: undefined,
    };
    var seenOptional = false;
    for (var i = 0; i < signature.length; i++) {
        const arg = signature[i]! as ShorthandArgument<string, string[]>;
        const next = signature[i + 1]! as ShorthandArgument<string, string[]>;
        var name: string, required = true, defaultExpr, lazy = Laziness.NONE, flags: string[] = [], j = 0;
        if (isString(arg)) {
            name = arg;
        } else {
            if (typeof arg === "boolean") throw new JEBSyntaxError(`invalid boolean flag at position ${i}`);
            if (isArray(arg[j])) flags = arg[j++] as string[];
            if (typeof arg[j] === "boolean") lazy = arg[j++] ? Laziness.QUOTED : Laziness.LAZY;
            if (!isString(arg[j])) {
                throw new JEBSyntaxError(`arg name not found at position ${i}`);
            }
            name = arg[j++] as string;
            if (j < arg.length) {
                required = false;
                defaultExpr = arg[j++];
            }
            if (j < arg.length) throw new JEBSyntaxError("unexpected junk after default expression");
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
}

/**
 * Callable hack from https://stackoverflow.com/a/78553691. Subclasses of this
 * are actually instances of `Function`, so `typeof this === "function"`.
 */
export abstract class CallableClass extends class { constructor(self: object) { return self; } } {

    constructor() {
        const self = setPrototypeOf(
            function (this: any, ...args: any[]) {
                if (new.target) return self.__new__(...args);
                return self.__call__(...args);
            }, new.target.prototype);
        super(self);
    }

    /**
     * Called when the object is invoked as a function (i.e. `this(...)`)
     */
    abstract __call__(...args: any[]): any;
    /**
     * Called when the object is invoked as a class constructor (i.e. `new this(...)`)
     */
    abstract __new__(...args: any[]): any;
    /**
     * "Private" kludge to prevent stuff that tests for typeof=="function" and automatically
     * `.bind()`s it to its owner from breaking.
     */
    private bind = () => this;
}


/**
 * Wrapper for a Javascript function that can be called by the JEB runtime.
 * The Javascript function has access to the VM so it can push opcodes to
 * implement more than just computation.
 */
export class BuiltinFunction<S extends CallableSignature = CallableSignature> implements HasDocstring {
    constructor(
        /**
         * The name of the function as it should appear in a traceback.
         */
        public readonly name: string,
        public readonly signature: S,
        /**
         * The javascript function implementation.
         *
         * If the function returns the special value {@link NOTHING}, no
         * value will be pushed as the result of the function call. Otherwise, the
         * return value is pushed (even if it's `undefined`).
         */
        public readonly impl: (
            args: Record<S["params"][number]["name"], any> & (S["rest"] extends { name: infer N extends PropertyKey } ? { [x in N]: any[] } : {}) & (S["kwRest"] extends { name: infer N extends PropertyKey } ? { [x in N]: Record<any, any> } : {}),
            vm: JebVM) => any,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        public readonly doc: string,
    ) { }
}

/**
 * A Fun is a callable function or macro implemented as JEB code instead of
 * a Javascript function.
 */
export class Fun<S extends CallableSignature<any, any, any>> extends CallableClass implements HasDocstring {
    constructor(
        /**
         * Whether the function should be hidden from stack traces.
         */
        public readonly isImplicit: boolean,
        /**
         * The name of the function as it should appear in a traceback. Ignored if isImplicit=true
         */
        public name: string | undefined,
        public readonly signature: S,
        /**
         * The body code that will be evaluated in the new scope with the argument values bound.
         */
        public readonly body: any,
        /**
         * The environment that this lambda closes over.
         */
        public readonly closureEnv: Env,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        public readonly doc: string,
    ) { super(); }
    /**
     * JEB lambdas are currently not callable via javascript.
     */
    __call__(): never {
        throw new JEBStateError("cannot call JEB fn");
    }
    /**
     * JEB lambda are not class constructors.
     */
    __new__(): never {
        throw new JEBStateError("cannot construct from JEB fn");
    }
}

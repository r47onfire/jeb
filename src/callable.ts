import { Block } from "./block";
import { type HasDocstring } from "./doc";
import { JEBStateError } from "./errors";
import { ApplyMetadata } from "./protocol";
import { CallableSignature } from "./signature";
import { Identifier } from "./utils";
import { JebVM } from "./vm";

const setPrototypeOf = Object.setPrototypeOf;

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
export class JSFun<S extends CallableSignature = CallableSignature> implements HasDocstring, ApplyMetadata {
    constructor(
        /**
         * The name of the function as it should appear in a traceback.
         */
        public readonly name: Identifier,
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
            vm: JebVM,
            location: Identifier | undefined,
        ) => any,
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
export class Fun<S extends CallableSignature<any, any, any>> extends CallableClass implements HasDocstring, ApplyMetadata {
    constructor(
        /**
         * Whether the function should be hidden from stack traces.
         */
        public readonly isImplicit: boolean,
        /**
         * The name of the function as it should appear in a traceback. Ignored if isImplicit=true
         */
        public name: Identifier | undefined,
        public readonly signature: S,
        /**
         * The body code that will be evaluated in the new scope with the argument values bound.
         */
        public readonly body: Block,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        public readonly doc: string,
    ) { super(); }
    get closureEnv() { return this.body.closureEnv; }
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

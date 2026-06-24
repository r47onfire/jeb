import { NOTHING } from "./builtins/utils";
import { type HasDocstring } from "./doc";
import { Env } from "./env";
import { Arity, JebVM } from "./vm";

const setPrototypeOf = Object.setPrototypeOf;

/**
 * Callable hack from stackoverflow.com/a/78553691. Subclasses of this
 * are actually instances of `Function`, so `typeof this === "function"`.
 */
export abstract class CallableClass extends Object {
    static {
        setPrototypeOf(this, class { constructor(self: any) { return self; } });
    }

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
    protected abstract __call__(...args: any[]): any;
    /**
     * Called when the object is invoked as a class constructor (i.e. `new this(...)`)
     */
    protected abstract __new__(...args: any[]): any;
    private bind(thisArg: any, ...argv: any[]) {
        return this;
    }
}


/**
 * Wrapper for a Javascript function that can be called by the JEB runtime.
 * It has access to the VM so it can push opcodes to implement more than
 * just computation.
 *
 * If it returns the special value {@link NOTHING}, no value will be pushed as
 * the result of the function call. Otherwise, the resturn value is pushed (even
 * if it's `undefined`).
 */
export class BuiltinFunction implements HasDocstring {
    constructor(
        /**
         * The name of the function as it should appear in a traceback.
         */
        public readonly name: string,
        public readonly arity: Arity,
        /**
         * Whether the function's arguments should be evaluated (false) or passed unevaluated (true).
         */
        public readonly isSpecial: boolean,
        /**
         * Whether the return value should be evaluated again in the caller's scope.
         */
        public readonly resultIsMacro: boolean,
        /**
         * The javascript function implementation
         */
        public readonly impl: (args: any[], vm: JebVM) => any,
        /**
         * The docstring given - should define the allowable syntax(es) of the function
         * or macro and give a description of its behavior.
         */
        public readonly doc: string,
    ) { }
}

/**
 * A Lambda is a callable function or macro implemented as JEB code instead of
 * a Javascript function.
 */
export class Lambda extends CallableClass implements HasDocstring {
    constructor(
        /**
         * Whether the return value should be evaluated again in the caller's scope.
         */
        public readonly isMacro: boolean,
        /**
         * Whether the lambda should be hidden from stack traces.
         */
        public readonly isImplicit: boolean,
        /**
         * The name of the function as it should appear in a traceback. Ignored if isImplicit=true
         */
        public name: string | undefined,
        /**
         * The names of the required arguments.
         */
        public readonly args: string[],
        /**
         * The names of the optional arguments along with their default expressions.
         * If the default is needed, the expression for it will be evaluated in a dynamic
         * environment consisting of the 
         */
        public readonly optArgs: [name: string, defaultExpression: any][],
        /**
         * The name of the rest argument at the end which will receive a list of
         * all arguments passed beyond the required and optional named arguments.
         * If null, there is no rest argument and the lambda has a maximum number of arguments.
         */
        public readonly restArg: string | null,
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
     * JEB lambda are currently not callable via javascript.
     */
    __call__(): never {
        throw new Error("Cannot call JEB lambda.");
    }
    /**
     * JEB lambda are not class constructors.
     */
    __new__(): never {
        throw new Error("Cannot construct from JEB lambda.");
    }
}

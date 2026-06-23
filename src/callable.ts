import { Doc, type HasDocstring, parseDoc } from "./doc";
import { Env } from "./env";
import { JebVM } from "./vm";

const setPrototypeOf = Object.setPrototypeOf;
/**
 * Callable hack from stackoverflow.com/a/78553691
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

    protected abstract __call__(...args: any[]): any;
    protected abstract __new__(...args: any[]): any;
    bind(thisArg: any, ...argv: any[]) {
        return this;
    }
}


export class BuiltinFunction implements HasDocstring {
    doc: Doc;
    constructor(
        public readonly name: string,
        public readonly arity: { min: number; max: number; } | number | null,
        public readonly isSpecial: boolean,
        public readonly resultIsMacro: boolean,
        public readonly impl: (args: any[], vm: JebVM) => any,
        doc: string,
    ) { this.doc = parseDoc(doc); }
}

export class Lambda extends CallableClass implements HasDocstring {
    doc: Doc;
    constructor(
        public readonly isMacro: boolean,
        public readonly isImplicit: boolean,
        public name: string | undefined,
        public readonly args: string[],
        public readonly optArgs: [string, any][],
        public readonly restArg: string | null,
        public readonly body: any,
        public readonly closureEnv: Env,
        doc: string,
    ) { super(); this.doc = parseDoc(doc); }
    __call__() {
        throw new Error("Cannot call JEB lambda.");
    }
    __new__() {
        throw new Error("Cannot construct from JEB lambda.");
    }
}

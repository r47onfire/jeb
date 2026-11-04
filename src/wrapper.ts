import { Reference } from "./protocol";

const TAG: unique symbol = Symbol.for("__tag__");

/**
 * Represents a wrapped value that only appears as a directly-usable value under
 * certain circumstances
 */
export abstract class Wrapper {
    /**
     * Tag identifying the kind of wrapper. `OP_unwrap` refuses to unwrap a
     * wrapper whose flag appears in its `dontUnwrap` list.
     */
    abstract flag: string;
    /** The wrapper's tag, said through the `__tag__` protocol property. */
    get [TAG](): string {
        return this.flag;
    }
    /** @param obj The wrapped value */
    constructor(readonly obj: any) {}
}

/** Wrapper for a keyword argument that will redirect to the */
export class KeywordArg extends Wrapper {
    flag = "keyword" as const;
    constructor(
        obj: any,
        readonly name: string,
    ) {
        super(obj);
    }
}

/** Wrapper to cause the object to unpack instead of being passed directly */
export class SplatArg extends Wrapper {
    flag = "splat" as const;
    constructor(
        obj: any,
        readonly isKeyword: boolean,
    ) {
        super(obj);
    }
}

/** Sentinel to force the parameter to use its default expression */
export class OptionArg extends Wrapper {
    flag = "option" as const;
    declare obj: string;
    constructor(obj: string) {
        super(obj);
    }
}

/** Sentinel to force the parameter to use its default expression */
export class EmptyArg extends Wrapper {
    flag = "empty" as const;
    declare obj: void;
    constructor() {
        super(0);
    }
}

/**
 * Wrapper for a variable reference. The wrapped value is usually a
 * {@link Reference}, but a descriptor object (an object with `__get__` /
 * `__set__` protocol methods) can be wrapped as-is too: the `get` and `assign`
 * opcodes read and assign through its methods, so it behaves like a reference
 * without being one.
 */
export class ReferenceWrapper extends Wrapper {
    flag = "ref" as const;
    constructor(obj: any) {
        super(obj);
    }
}

/** Wrapper for a macro result */
export class MacroWrapper extends Wrapper {
    flag = "macro" as const;
}

import { AccessType, Reference } from "./reference";

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
 * Wrapper for a variable reference. The wrapped value is a {@link Reference}.
 */
export class ReferenceWrapper extends Wrapper {
    flag = "ref" as const;
}

/** Wrapper for a macro result */
export class MacroWrapper extends Wrapper {
    flag = "macro" as const;
}

/**
 * A sentinel value that stops a chain of calls and accesses, absorbing each
 * one and returning itself, so a chain that hits `undefined` or `null`
 * anywhere produces that value at the end instead of throwing.
 *
 * Unlike Javascript (where `null?.x` evaluates to `undefined`) the hole wraps
 * the specific `undefined` or `null` it came from.
 *
 * The hole is also a {@link Reference} (to itself, for every field): reading
 * it returns itself, and assigning to it does nothing. It lives here, with
 * the other wrappers, because the core opcodes dispatch on it directly.
 */
export class NullHole extends Wrapper implements Reference {
    flag = "hole" as const;
    /** The hole stands in for a property slot that was never there. */
    readonly type = AccessType.PROPERTY;
    /** Returns itself. */
    get(): this {
        return this;
    }
    /** Does nothing. */
    set() {}
}

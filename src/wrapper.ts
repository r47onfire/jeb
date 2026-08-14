import { Reference } from "./protocol";

/**
 * Represents a wrapped value that only appears as a directly-usable value under certain circumstances
 */
export abstract class Wrapper {
    abstract flag: string;
    constructor(public obj: any) { };
}

/**
 * Wrapper for a keyword argument that will redirect to the
 */
export class KeywordArg extends Wrapper {
    flag = "keyword" as const;
    constructor(obj: any, public name: string) { super(obj); }
}

/**
 * Wrapper to cause the object to unpack instead of being passed directly
 */
export class SplatArg extends Wrapper {
    flag = "splat" as const;
    constructor(obj: any, public isKeyword: boolean) { super(obj); }
}

/**
 * Wrapper for a variable reference
 */
export class ReferenceWrapper extends Wrapper {
    flag = "ref" as const;
    declare obj: Reference;
}

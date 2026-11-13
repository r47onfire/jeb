import { Env } from "./env";
import { JSONCode } from "./evaluate";
import { Signature } from "./signature";
import { Identifier } from "./utils";

/**
 * A function implemented as JEB code: a {@link Signature} wrapped around a block
 * of code. Calling the closure binds the arguments against the signature (see
 * `bindArgs`) in a child of the closed-over environment and evaluates the body
 * there, with `return` bound to the call's continuation.
 */
export class Closure<D = any> {
    constructor(
        /** The parameters the arguments are bound against. */
        readonly signature: Signature,
        /** The environment the body forms were defined in. */
        readonly env: Env<D>,
        /** The body forms, evaluated in order like a `begin`. */
        readonly body: readonly JSONCode[],
        /**
         * Name to show in tracebacks when the call site doesn't provide one.
         * Set by layers that bind closures to names.
         */
        public name: Identifier | undefined = undefined,
    ) {}
}

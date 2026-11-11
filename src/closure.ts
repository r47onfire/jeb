import { Block } from "./block";
import { Env } from "./env";
import { Identifier } from "./utils";

/**
 * A function implemented as IR code. Every non-native function value is a
 * `Closure` -- the only other callable values are native host functions and
 * continuations.
 *
 * A closure is a parameter list wrapped around a {@link Block}: the block holds
 * the body and the environment it was defined in, exactly like the blocks that
 * lazy parameters are made of. Calling the closure binds the arguments in a
 * child of the block's environment and invokes the block in that new
 * environment.
 *
 * There are no signatures or wrappers at this level: every argument is
 * evaluated by the `call` opcode before the closure is invoked, and special
 * forms are opcodes, not functions. Semantics like keyword arguments, defaults,
 * and lazy parameters belong to the layer above, which builds them out of
 * closures and blocks.
 */
export class Closure<D = any, C = any> {
    constructor(
        /** Positional parameter names, bound in order. */
        readonly params: readonly Identifier[],
        /**
         * Name bound to an array of any remaining arguments, or `undefined` if
         * the closure takes exactly {@link params}.
         */
        readonly rest: Identifier | undefined,
        /** The wrapped block: the body and its defining environment. */
        readonly block: Block<D, C>,
        /**
         * Name to show in tracebacks. Set by `define`/`let` when the closure is
         * first bound to a name and it doesn't have one yet.
         */
        public name: Identifier | undefined = undefined,
    ) {}
    /** The environment the body closes over (the block's). */
    get env(): Env<D> {
        return this.block.closureEnv;
    }
    /** The body nodes (the block's). */
    get body() {
        return this.block.body;
    }
}

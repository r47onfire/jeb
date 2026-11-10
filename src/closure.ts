import { Env } from "./env";
import { IRNode } from "./ir";
import { Identifier } from "./utils";

/**
 * A function implemented as IR code: a parameter list, a body (a list of IR
 * nodes, evaluated like a `seq` whose last node is in tail position), and the
 * environment the `lambda` node was evaluated in.
 *
 * There are no signatures, laziness, or wrappers at this level: every argument
 * is evaluated by the `call` opcode before the closure is invoked, and special
 * forms are opcodes, not functions. Semantics like keyword arguments, defaults,
 * and lazy parameters belong to the layer above (e.g. Kuiper), which can build
 * them out of these primitives.
 */
export class Closure {
    constructor(
        /** Positional parameter names, bound in order. */
        readonly params: readonly Identifier[],
        /**
         * Name bound to an array of any remaining arguments, or `undefined` if
         * the closure takes exactly {@link params}.
         */
        readonly rest: Identifier | undefined,
        /** Body nodes, evaluated in a child of {@link env} per call. */
        readonly body: readonly IRNode<any>[],
        /** The environment captured where the `lambda` node was evaluated. */
        readonly env: Env,
        /**
         * Name to show in tracebacks. Set by `define`/`let` when the closure is
         * first bound to a name and it doesn't have one yet.
         */
        public name: Identifier | undefined = undefined,
    ) {}
}

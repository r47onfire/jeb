import { Env } from "./env";
import { IRNode } from "./ir";

/**
 * A chunk of code whose evaluation is deferred: the body nodes plus the
 * environment they are evaluated in when the block is invoked.
 *
 * Blocks are the runtime's one deferred-evaluation mechanism. Calling a block
 * (through the `call` opcode, with no arguments) evaluates its body like a
 * `seq` in its captured environment. Higher layers build lazy parameters out of
 * blocks: an argument that must not be evaluated at the call site is passed as
 * a block, and the callee invokes it if and when it wants the argument's
 * value.
 */
export class Block {
    constructor(
        /** The environment the body is evaluated in when invoked. */
        readonly closureEnv: Env,
        /** The deferred body nodes. */
        readonly body: readonly IRNode<any>[],
    ) {}
}

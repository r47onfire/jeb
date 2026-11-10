import { undefinedToNull } from "lib0/conditions";
import { Block } from "../block";
import { define, makeJSFun, makeOpcode, NOTHING } from "../define";
import { checkNothingOrPush } from "../errors";
import { AccessType, Reference } from "../reference";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { NullHole, ReferenceWrapper } from "../wrapper";
import { OP_index, runSetter } from "./eval";
import { OP_unwrap, OP_wrap } from "./unwrap";
import { OP_block_invoke, OP_push_value } from "./variables";

export { NullHole } from "../wrapper";

/**
 * Continuation of a read through a {@link NullChainReference}: the fetched value
 * is on top of the data stack; a fetched `undefined` or `null` becomes the hole
 * (wrapping it), and anything else is left as it is. This is the one place a
 * fetched value turns into the hole.
 */
const OP_hole_finish = makeOpcode(
    null,
    (vm: JebVM) => {
        const value = popData(vm);
        pushData(
            vm,
            undefinedToNull(value) === null ? new NullHole(value) : value,
        );
    },
    null,
);

/**
 * The reference `index_null` returns for a real (non-nullish) receiver: a
 * reference like the one `index` would return, except that reading it turns a
 * fetched `undefined` or `null` into the hole, so a chain that continues with
 * plain `index` / calls from here is still null-safe. Assigning through it
 * assigns to the inner reference as usual.
 */
export class NullChainReference extends Reference {
    constructor(readonly inner: Reference) {
        super(AccessType.PROPERTY);
    }
    get(vm: JebVM, shouldBind: boolean) {
        pushCommand(vm, OP_hole_finish);
        checkNothingOrPush(vm, this.inner.get(vm, shouldBind));
        return NOTHING;
    }
    set(vm: JebVM, value: any, create: boolean, readonly: boolean) {
        runSetter(vm, this.inner, value, { create, readonly });
    }
}

export const B_index_null = makeJSFun(
    "index_null",
    [
        [["hole"], "obj"],
        [false, "name"],
    ],
    ({ obj, name }, vm) => {
        const key = name as Block;
        if (obj === undefined || obj === null) {
            // A nullish receiver becomes the hole directly; the key is
            // never evaluated.
            pushCommand(vm, OP_wrap, NullHole);
            pushData(vm, obj);
            return NOTHING;
        }
        if (obj instanceof NullHole) {
            // The chain is already in the hole; the key is never evaluated.
            pushData(vm, obj);
            return NOTHING;
        }
        // A real receiver: index it exactly like `index` does, but the
        // reference is wrapped so that reading it turns a fetched
        // `undefined` or `null` into the hole.
        pushCommand(vm, OP_wrap, ReferenceWrapper);
        pushCommand(vm, OP_wrap, NullChainReference);
        pushCommand(vm, OP_index, AccessType.PROPERTY);
        // The key is evaluated like a call argument: its result is
        // unwrapped (an inner index's reference reads through).
        pushCommand(vm, OP_unwrap, ["splat", "keyword", "empty", "option"]);
        pushCommand(vm, OP_block_invoke, key, false);
        pushCommand(vm, OP_push_value, { _: {} });
        pushData(vm, obj);
        return NOTHING;
    },
    `.func (index_null obj name)
..param {any} obj
..param {PropertyKey} name
.pure
. Returns a reference to \`obj[name]\`, like [[index]], but null-safe: if \`obj\` is \`undefined\` or \`null\` the result is the null-chaining hole instead (and the key is not evaluated), and reading the reference turns a fetched \`undefined\` or \`null\` into the hole as well, so a chain of accesses and calls that hits a missing value anywhere produces that value at the end instead of throwing.`,
);

export const loadNullChainBuiltins = (vm: JebVM) => {
    define(vm, "index_null", B_index_null);
};

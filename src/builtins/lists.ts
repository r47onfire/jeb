import { define, makeJSFun } from "../define";
import { ErrnoCode } from "../errno";
import { wrapThrowToError } from "../errors";
import { withType } from "../protocol";
import { JebVM } from "../vm";

export const B_list = makeJSFun("list", [[1, "values"]], ({ values }) => values,
    `.func (list values...)
..param {T} values...
.pure
.returns {T[]}
. Returns the arguments in a list.`);
export const B_head = makeJSFun("head", ["list"], ({ list }) => withType(list, [Array], "list")[0],
    `.func (head list)
..param {T[]} list
.pure
.returns {T} - The first element in the list`);
export const B_tail = makeJSFun("tail", ["list"], ({ list }) => withType(list, [Array], "list").slice(1),
    `.func (tail list)
..param {T[]} list
.pure
..returns {T[]} - A copy of the list without the first element`);
export const B_concat = makeJSFun("concat", [[1, "lists"]], ({ lists }) => {
    const out: any[] = [];
    for (var arg of lists) {
        wrapThrowToError(ErrnoCode.EINVAL, () => out.push(...arg as any));
    }
    return out;
},
    `.func (concat lists...)
..param {T[]} lists...
If an argument is not a list, the value is coerced to a list using the Javascript \`...\` spread operator.
.returns {T[]}
. Concatenates the lists, and returns a new list.`)

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadDataBuiltins = (vm: JebVM) => {
    define(vm, "list", B_list);
    define(vm, "head", B_head);
    define(vm, "tail", B_tail);
    define(vm, "concat", B_concat);
};

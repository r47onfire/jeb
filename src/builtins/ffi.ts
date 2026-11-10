import { undefinedToNull } from "lib0/conditions";
import { define, makeJSFun } from "../define";
import { JebVM } from "../vm";

export const B_is_nil = makeJSFun(
    "nil?",
    ["value"],
    ({ value }) => undefinedToNull(value) === null,
    `.func (isNil value)
..param {any} value
.pure
.returns {boolean}
. \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might still be falsy.`,
);

/**
 * Registers this file's builtins in the VM's builtins scope, in the order
 * listed. Called by {@link loadBuiltins}.
 */
export const loadFFIBuiltins = (vm: JebVM) => {
    define(vm, "isNil", B_is_nil);
};

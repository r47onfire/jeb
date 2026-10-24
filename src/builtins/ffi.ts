import { undefinedToNull } from "lib0/conditions";
import { define, defineApplier, makeJSFun, makeOpcode } from "../define";
import { ErrnoCode } from "../errno";
import { wrapThrowToError } from "../errors";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { ALL_UNDERSCORE_NORMAL } from "./eval";

// MARK: FFI
const loadFFIApplier = (vm: JebVM) => defineApplier(vm, ["function"], (vm, { 0: f }) => {
    pushCommand(vm, OP_ffi_invoke, f);
}, (_, f) => ({
    name: `[JS function ${f.name || "<no name>"}]`,
    signature: ALL_UNDERSCORE_NORMAL,
    macro: (f as any).MACRO ?? false,
}),
    `JEB's FFI can call Javascript functions. JEB does not check the \`.length\` of the function since it is wrong in some cases.
.throws EJAVASCRIPT - if the FFI'ed function throws an error`);
const OP_ffi_invoke = makeOpcode(null, (vm: JebVM, { 0: f }: [Function]) => {
    const args = popData(vm)._;
    vm.emit("jeb:ffi/call_function", [f, args]);
    pushData(vm, wrapThrowToError(ErrnoCode.EJAVASCRIPT, () => f(...args)));
}, null);

export const B_is_nil = makeJSFun("nil?", ["value"], ({ value }) => undefinedToNull(value) === null,
    `.func (isNil value)
..param {any} value
.pure
.returns {boolean}
. \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might still be falsy.`);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadFFIBuiltins = (vm: JebVM) => {
    define(vm, "isNil", B_is_nil);
    loadFFIApplier(vm);
};

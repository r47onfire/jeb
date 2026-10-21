import { Block } from "../block";
import { DynamicWind, Windable } from "../continuation";
import { define, makeJSFun, makeOpcode, NOTHING } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { withType } from "../protocol";
import { Identifier, isIdentifier } from "../utils";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { OP_apply, OP_if, OP_shuffle } from "./eval";
import { OP_block_invoke } from "./variables";

// MARK: error handling
export const OP_throw = makeOpcode("throw", (vm: JebVM, { 0: err }: [JEBError]) => {
    while (vm.curDynamicWind.parent) {
        // call exit handler with error details
        // if it returns true, it means the error was handled and we can continue execution
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        dw.restore(vm);
        if (dw.handler?.exit) {
            pushCommand(vm, OP_if, null, [OP_throw, err], true);
            pushCommand(vm, OP_apply, [false, err], undefined, false, true);
            pushData(vm, dw.handler.exit);
            return;
        }
    }
    // if there's nothing to catch the error, queue it to be thrown back to Javascript
    vm.error = err;
},
    `.imm err
..param {JEBError} err
.sed -- (does not return)
. Throws the error, but allows [[with]] handlers to catch it before throwing to Javascript.`);
export const B_throw = makeJSFun("throw", ["err"], ({ err }) => {
    if (!(err instanceof JEBError)) throw new JEBError(ErrnoCode.EINVAL, "errors must inherit from JEBError");
    throw err;
},
    `.func (throw err)
..param {JEBError} err
.returns {never}
. Throw an error. If we're inside a [[with]] block, it will trigger the \`exit\` handler of the context object to possibly handle the error.
If the error is not handled, it will be thrown as a Javascript error, causing the program to halt.`);
export const B_err = makeJSFun("err", [["type", "EPANIC"], ["message", "no message"], ["up", 0]], ({ type, message, up }, vm) => new JEBError(ErrnoCode[withType(type, ["string"], "type") as any] ?? type as any, withType(message, ["string"], "message"), {}, {}, vm.tracebackArray(withType(up, ["number"], "up"))),
    `.func (err message type up)
..param {string?} [message="no message"]
..param {string?} type - errno code for error
..param {number?} [up=0] - number of stack frames to drop (in order to e.g. attribute the error to the caller)
. Creates a new error object, but does not actually throw it (use [[throw]] for that).`);
// MARK: with
export const B_with = makeJSFun("with", [[true, "binding"], "context", [false, "body"], true], ({ binding, context, body }, vm) => {
    if (!isIdentifier(binding) && binding !== null) {
        throw new JEBError(ErrnoCode.EINVAL, "expected variable name or null as first argument to \"with\"")
    }
    // Capture "from" here so that it doesn't capture the "with/teardown" opcode
    const dw = vm.newDynamicWind();
    // this looks backwards because it is - it's a stack, so the last one pushed (at the bottom)
    // is the first one executed
    pushCommand(vm, OP_with_teardown);
    pushCommand(vm, OP_block_invoke, body as any as Block, false);
    pushCommand(vm, OP_with_setup, dw, binding);
    pushData(vm, context);
    return NOTHING;
},
    `.macro (with varname context body...)
..param {string | null} varname
...receives {T} - Return value of the \`enter\` handler (if present)
..param {object} handlers
...prop {(continuation: boolean) => T} [enter=null]
When entering the block, the \`enter\` hook will be called with \`true\` or \`false\` to indicate if the entry is due to a continuation or not. The first time the block is entered, the return value of the \`enter\` hook will be bound to the \`varname\`.
...prop {(continuation: boolean, err: JEBError | null) => boolean} exit
When exiting the block, the \`exit\` hook will be called. \`continuation\` is as with the \`enter\` handler (indicating if the block exit is due to a continuation or not), and \`err\` will be \`null\` if there is no error being handled, or non-\`null\` if there is an error in progess. The \`exit\` handler can return \`true\` to indicate that it has handled the error, and prevent it from propagating up the call stack.
Some errors also include a *restart* as part of their \`.context\` - this will be a continuation that when invoked, will jump back to the expression that caused the error and resume execution with the substituted value. It is usually named \`return\`.
..param {code} body...
.throws EINVAL - if \`varname\` is null or \`handlers\` is not an object.
. Used to manage error handling, contextual resources, and continuation tracking.`);

const OP_with_setup = makeOpcode(null, <T extends JebVM>(vm: T, { 0: dw, 1: name }: [DynamicWind<T>, Identifier | null]) => {
    // we just got the before and after handlers evaluated
    const context = popData(vm) as Windable;
    const notObject = typeof context !== "object" || context === null;
    if (notObject || !("enter" in context || "exit" in context)) {
        throw new JEBError(ErrnoCode.EINVAL, notObject ? "context manager should be an object" : "context manager should have 'enter' and/or 'exit' handlers");
    }
    dw.setHandler(context);
    // set up the winder to be installed AFTER the enter handler runs, so that errors thrown by this handler won't be caught by the exit handler
    pushCommand(vm, OP_with_install<T>, dw);

    // The result of the follwing options must be an args object to the block body invocation
    pushCommand(vm, OP_with_boxprepare, name);
    if (!context.enter) {
        pushData(vm, {});
        return;
    }
    pushCommand(vm, OP_apply, [false], undefined);
    pushData(vm, context.enter);
}, null);

const OP_with_boxprepare = makeOpcode(null, (vm: JebVM, { 0: name }: [Identifier | null]) => pushData(vm, { _: name !== null ? { [name]: popData(vm) } : (popData(vm), {}) }), null);

const OP_with_install = makeOpcode(null, <T extends JebVM>(vm: T, { 0: dw }: [DynamicWind<T>]) => {
    vm.curDynamicWind = dw;
}, null);

const OP_with_teardown = makeOpcode(null, vm => {
    if (!vm.curDynamicWind.parent) throw new JEBError(ErrnoCode.EPANIC, "dynamic wind stack underflow");
    const dw = vm.curDynamicWind;
    vm.curDynamicWind = dw.parent!;
    if (!dw.handler?.exit) return;
    // discard the exit handler's result
    pushCommand(vm, OP_shuffle, 1, []);
    pushCommand(vm, OP_apply, [false, null], undefined);
    pushData(vm, dw.handler.exit);
}, null);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadControlBuiltins = (vm: JebVM) => {
    define(vm, "throw", B_throw);
    define(vm, "err", B_err);
    define(vm, "with", B_with);
};

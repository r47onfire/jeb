import { isArray } from "lib0/array";
import { isString } from "lib0/function";
import { Block } from "../block";
import { Fun } from "../callable";
import { Continuation } from "../continuation";
import { define, defineApplier, makeJSFun, makeOpcode } from "../define";
import { withType } from "../protocol";
import { createSignature, Laziness } from "../signature";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { OP_block_invoke } from "./variables";

// MARK: fn/block applier
const loadFunBlockAppliers = (vm: JebVM) => {
    defineApplier(vm, [Fun], (vm, { 0: fn }, { tail }) => pushCommand(vm, OP_fun_invoke, fn, tail),
        (_, fn) => ({
            name: fn.isImplicit ? undefined : fn.name ?? "[anonymous]",
            signature: fn.signature,
            closureEnv: fn.closureEnv,
        }),
        "\"Compiled\" wrapper for a function or macro defined entirely out of JEB code (which is just JSON).");

    defineApplier(vm, [Block], (vm, { 0: b }, { tail }) => pushCommand(vm, OP_block_invoke, b, tail),
        (_, b) => ({
            name: undefined,
            signature: {
                params: [{ name: "_", required: false, defaultExpr: {}, lazy: Laziness.NONE, flags: [] }],
                rest: undefined,
                kwRest: undefined,
            },
            closureEnv: b.closureEnv,
        }),
        "Deferred block evaluation");
};
const OP_fun_invoke = makeOpcode(null, (vm: JebVM, { 0: fn, 1: tail }: [Fun<any>, boolean | undefined]) => {
    const argvObject = popData(vm);
    if (!fn.isImplicit) argvObject.return = vm.cc();
    pushCommand(vm, OP_block_invoke, fn.body, tail);
    pushData(vm, { _: argvObject });
}, null);

export const B_fn = makeJSFun("fn", [[true, "params"], [true, "body"], true], ({ params, body }, vm) => {
    var isImplicit = false;
    if (!isArray(params)) {
        isImplicit = params as any;
        params = withType(body![0], [Array], "fn.params");
        body = body!.slice(1);
    }
    var docstring = "";
    if (isString(body![0]) && body!.length > 1) {
        docstring = body![0];
        body = body!.slice(1);
    }
    return new Fun(isImplicit, undefined, createSignature(params), new Block(vm.currentEnv, body!), docstring);
},
    `.macro (fn (parameters...) body...) (fn true (parameters...) docstring body...)
The form with \`true\` right after the \`fn\` defines it as an implicit function, where the special \`return\` continuation is not injected and the call will not show up in the traceback of an error (it would normally show as \`[anonymous]\` unless assigned to a name).
..param {...} parameters - list of parameter names and flags
There are many forms that the paremeter can take to control is behavior at call time:
* \`bare string name\` - normal required parameter.
* \`[string name, default]\` - the parameter is optional, and if it is not provided in a call, then the value of \`default\` is evaluated in a dynamic environment of both the environment in which the function was defined, as well as the environment from which it was called.
* \`[true, string name]\` - defines the parameter to be a macro control parameter; the value the function body sees is the **unevaluated AST** of the expression instead of the result of evaluating the expression
* \`[false, string name]\` - defines the parameter to be a "lazy" parameter; the value the function body sees is a [[block]] wrapper object for the expression's unevaluated AST instead
* \`[flags list, string name]\` - normal required parameter, except that return values wrapped with special wrappers matching names in the flags list are **not** unwrapped, allowing the function body to operate on the wrapper itself directly
* \`[flags list, string name, default]\` - same as above with flags and default semantics
* \`[flags list, false, string name]\` - same as block wrapper form with flags to prevent unwrapping of other types
* \`true\` or \`false\` after a parameter - defines the parameter to be a rest parameter (for \`true\`) or keyword rest parameter (for \`false\`) that will be an array or object at runtime filled with all the positional or keyword arguments given after it. It cannot have a default since defining it as a rest parameter implicitly defines the default as \`[]\` or \`{}\`.
..param {string} docstring - Defines the documentation string for this function. The first element of the body will only be interpreted as a docstring if there is at least one statement after it (rendering the string otherwise pointless).
..param {code} body... - Statements to be executed in sequence (as with [[begin]]) to calculate the return value of the function.
...injected {Continuation} return - if the first element after \`fn\` is not \`true\`, a continuation jumping back to where the function was called from is injected into the \`return\` variable.
.pure
.returns {Fun}
. Returns a new anonymous function with the specified parameters, documentation string, and body.`);

// MARK: continuation applier
const loadContinuationApplier = (vm: JebVM) => defineApplier(vm, [Continuation], (vm, { 0: k }) => {
    pushCommand(vm, OP_continuation_invoke, k);
}, () => ({
    name: "<continuation>",
    macro: false,
    signature: {
        params: [{
            name: "value",
            required: true,
            defaultExpr: undefined,
            lazy: Laziness.NONE,
            flags: [],
        }],
        rest: undefined,
        kwRest: undefined,
    }
}),
    "Reified GOTO which will jump back to the place it was captured from and return from there instead of returning from where it was called from like usual.");
const OP_continuation_invoke = makeOpcode(null, <T extends JebVM>(vm: T, { 0: k }: [Continuation<T>]) => k.invoke(vm, popData(vm).value), null);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadCallablesBuiltins = (vm: JebVM) => {
    define(vm, "fn", B_fn);
    loadFunBlockAppliers(vm);
    loadContinuationApplier(vm);
};

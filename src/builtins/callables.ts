import { isArray } from "lib0/array";
import { isString } from "lib0/function";
import { Block } from "../block";
import { Fun } from "../callable";
import { Continuation } from "../continuation";
import { define, makeJSFun, makeOpcode } from "../define";
import {
    createSignature,
    ShorthandArgument
} from "../signature";
import { withType } from "../typecheck";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { OP_apply, OP_shuffle } from "./eval";
import { OP_block_invoke } from "./variables";

export const OP_fun_invoke = makeOpcode(
    null,
    (vm: JebVM, { 0: fn, 1: tail }: [Fun<any>, boolean | undefined]) => {
        const argvObject = popData(vm);
        if (!fn.isImplicit) argvObject.return = vm.cc();
        pushCommand(vm, OP_block_invoke, fn.body, tail);
        pushData(vm, { _: argvObject });
    },
    null,
);

export const B_fn = makeJSFun(
    "fn",
    [
        [true, "params"],
        [true, 0, "body"],
    ],
    ({ params, body }, vm) => {
        var isImplicit = false;
        if (!isArray(params)) {
            isImplicit = params as any;
            // TODO: #38
            params = withType(body![0], [Array], "fn.params");
            body = body!.slice(1);
        }
        var docstring = "";
        if (isString(body![0]) && body!.length > 1) {
            docstring = body![0];
            body = body!.slice(1);
        }
        return new Fun(
            isImplicit,
            undefined,
            // TODO: #38 - this throws based on which parameter
            createSignature(params as readonly ShorthandArgument<any, any>[]),
            new Block(vm.currentEnv, body!),
            docstring,
        );
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
. Returns a new anonymous function with the specified parameters, documentation string, and body.`,
);

// MARK: continuation applier
export const OP_continuation_invoke = makeOpcode(
    null,
    <T extends JebVM>(vm: T, { 0: k }: [Continuation<T>]) =>
        k.invoke(vm, popData(vm).value),
    null,
);

/**
 * Registers this file's builtins in the VM's builtins scope, in the order
 * listed. Called by {@link loadBuiltins}.
 */
export const loadCallablesBuiltins = (vm: JebVM) => {
    define(vm, "fn", B_fn);
};

/**
 * Schedules a call to a function with already-computed argument values: the
 * method is applied through `OP_apply` with `noEval` set, so `OP_doargs` binds
 * the values as they are. If `dropResult` is set, the value the method returns
 * is discarded.
 */
export const pushSyntheticCall = (
    vm: JebVM,
    method: any,
    args: any[],
    dropResult: boolean,
) => {
    if (dropResult) pushCommand(vm, OP_shuffle, 1, []);
    pushData(vm, method);
    pushCommand(vm, OP_apply, args, undefined, false, true);
};

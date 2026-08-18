import { isinstance } from "@r47onfire/game-math";
import { isArray } from "lib0/array";
import { undefinedToNull } from "lib0/conditions";
import { id, isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { add } from "lib0/math";
import { keys } from "lib0/object";
import { Err, Ok, Result } from "ts-res";
import { BuiltinFunction, CallableSignature, createSignature, Lambda, Laziness } from "../callable";
import { Continuation, Windable } from "../continuation";
import { Env } from "../env";
import { ALL_ERRORS, checkNothingOrPush, JEBError, JEBSyntaxError, JEBTypeError, JEBValueError, wrapThrowToError } from "../errors";
import { float, numberOp, Relation } from "../math";
import { AccessType, Reference, theTypeName, typeOf } from "../protocol";
import { JebVM } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import { alias, defineAccessor, defineApplier, defineBuiltin, defineEvaluator, defineOpcode, NOTHING } from "./define";
import { registerDoargs } from "./doargs";
import { implicitBegin } from "./implicitBegin";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { registerUnwrap } from "./unwrap";
import { Writable } from "../utils";

// TODO: split this all up
// MARK: loadBuiltins()
/**
 * Install the built-in functions and opcodes to the builtins scope of the given VM.
 *
 * Usually you don't need to do this, since the {@link JebVM} constructor calls this automatically,
 * but it might be needed if the VM state gets corrupted, or you mess with {@link JebVM#builtinsEnv} directly.
 */
export const loadBuiltins = (vm: JebVM) => {


    // MARK: op: traceback push/pop
    defineOpcode(vm, "jeb:tb_pop", vm => vm.popTraceback(),
        `.imm
.sed --
. Pops the top of the traceback stack, including all tailcall entries if there are some.`);
    defineOpcode(vm, "jeb:tb_push", (vm, { 0: func, 1: tail }) => vm.pushTraceback(func, tail ?? false),
        `.imm function tailcall
..param {string} function
..param {boolean} [tailcall=false]
. Pushes the function to the traceback stack.`);

    // MARK: op: stack shuffle
    defineOpcode(vm, "jeb:shuffle", (vm, { 0: n, 1: indices }) => {
        const items = vm.popNData(n);
        for (var i = 0; i < indices.length; i++) {
            vm.pushData(items[indices[i]!]!);
        }
    },
        `.imm count indices
.param {number} count
.param {number[]} indices
. Pops \`count\` items off the stack, and then pushes the items back on in the order defined by \`indices\`.
Examples:
* \`N/[0, 1, 2, 3, ..., N-1]\` = identity
* \`2/[1, 0]\` = swap
* \`1/[]\` = drop
* \`1/[0, 0]\` = dup
* \`N/[1, 2, 3, 4, ..., N-1, 0]\` = N-tuck`);

    // MARK: eval
    defineOpcode(vm, "jeb:eval", (vm, { 0: tail }) => {
        const code = vm.popData();
        const p = vm.getProtocol(true, false, "eval", [code]);
        if (p) p.run(vm, [code], { tail: tail ?? false });
        else vm.pushData(code);
    },
        `.imm tailcall
.param {boolean?} [tailcall=false]
.sed value -- evaled
. Evaluates the top item of the stack. An array gets interpreted as a call and passed to [[jeb:apply]], an object has all its properties evaluated and reassembled, and anything else is treated as a literal and left as-is.`);
    defineBuiltin(vm, "eval", ["arg"], false, ({ arg }, vm) => { vm.pushData(arg); vm.pushCommand("jeb:eval"); return NOTHING; },
        `.func (eval arg)
..param {any} arg
.returns {any}
. Evaluates \`arg\` in the current environment.`);

    defineEvaluator(vm, ["object"], (vm, { 0: code }) => {
        if (code === null) {
            vm.pushData(null);
            return;
        }
        // evaluate all the properties
        const target = {};
        vm.pushData(target);
        for (var key of keys(code)) {
            vm.pushData(new ObjectPropertyReference(AccessType.PROPERTY, target, key));
            vm.pushData(code[key]);
            vm.pushCommand("jeb:shuffle", 1, []);
            vm.pushCommand("jeb:set", true);
            vm.pushCommand("jeb:shuffle", 2, [1, 0]);
            vm.pushCommand("jeb:eval");
        }
    },
        "Evaluates all of the property values, and then reassembles the object with the same set of keys with the evaluated values.");
    defineEvaluator(vm, [Array], (vm, { 0: code }, { tail }) => {
        if (code.length > 0) {
            vm.pushCommand("jeb:apply", code.slice(1), tail);
            vm.pushCommand("jeb:unwrap", []);
            vm.pushCommand("jeb:eval");
            vm.pushData(code[0]);
        }
        else throw new JEBValueError("can't evaluate empty array", { return: vm.cc() });
    },
        `Calls the first item as a function.
.throws jeb:type_error - if the first item is not callable
.throws jeb:value_error - if the list is empty`);

    // MARK: apply
    defineOpcode(vm, "jeb:apply", (vm, { 0: argv, 1: tail, 2: noEval }) => {
        const func = vm.popData();
        const applier = vm.getProtocol(true, false, "apply", [func]);
        if (!applier) {
            throw new JEBTypeError(`can't call ${theTypeName(typeOf(func))}`, { return: vm.cc() });
        }
        const { name, macro, signature, closureEnv } = applier.describe(vm, func);
        if (name && !tail) vm.pushCommand("jeb:tb_pop");
        if (macro) vm.pushCommand("jeb:eval");
        applier.run(vm, [func], { tail: tail ?? false });
        if (name) vm.pushCommand("jeb:tb_push", name, tail);
        vm.pushCommand("jeb:doargs", signature, closureEnv, noEval ?? false);
        vm.pushData(argv);
    },
        `.imm expressions tailcall
..param {code[]} expressions
..param {boolean?} [tailcall=false]
.sed functor -- result
.throws jeb:type_error - when the object is not callable
.throws jeb:value_error - when the argument count is wrong
. Pops the top value from the stack and calls it with the provided arguments.
The arguments expressions are expected to be unevaluated, and the signature of the thing being called will determine whether the argument given is evaluated or not.`);
    registerDoargs(vm);
    registerUnwrap(vm);
    // MARK: string applier
    defineOpcode(vm, "jeb:apply/string-trampoline", (vm, { 0: tail }) => {
        const realFunc = vm.popData();
        const argsObj = vm.popData() as { _: any[] };
        vm.pushData(realFunc);
        vm.pushCommand("jeb:apply", argsObj._, tail);
    }, null);
    defineApplier(vm, ["string"], (vm, { 0: func }, { tail }) => {
        // String is a special case because normally strings evaluate to themselves
        // (not to a callable function), but if it's in head position, we implicitly look it up.
        vm.pushCommand("jeb:apply/string-trampoline", tail);
        vm.pushCommand("jeb:unwrap", []);
        vm.pushCommand("jeb:get", false);
        vm.pushCommand("jeb:shuffle", 2, [1, 0]);
        vm.pushData(new VariableReference(AccessType.FUNCTION, vm.currentEnv, func));
    }, () => ({
        name: undefined,
        signature: ALL_UNDERSCORE_QUOTED,
        macro: false,
    }),
        `Applying a string is shorthand for looking up the variable with the same name as the string and calling that instead.
As a consequence, \`('foo)\` is the same as \`(foo)\` in JEB even though the former would be invalid in conventional Lisp.`);
    // MARK: builtin applier
    defineApplier(vm, [BuiltinFunction],
        (vm, { 0: func }) => vm.pushCommand("jeb:builtin/invoke", func),
        (_, func) => func,
        "Wrapper for a Javascript function that gives it a few properties to make it easier for JEB to call it.");
    defineOpcode(vm, "jeb:builtin/invoke", (vm, { 0: func }) => checkNothingOrPush(vm, func.impl(vm.popData(), vm)), null);

    // MARK: variables
    defineAccessor(vm, ["object"], (_, { 0: object }, { field, type }) => new ObjectPropertyReference(type, object, field), "Default object property accessor.");
    defineAccessor(vm, [Env], (_, { 0: env }, { field, type }) => new VariableReference(type, env, field as string), "Accessor for variables from an environment.");
    defineOpcode(vm, "jeb:index", (vm, { 0: type }) => {
        const field = vm.popData() as PropertyKey;
        const obj = vm.popData();
        const accessor = vm.getProtocol(true, false, "access", [obj]);
        if (!accessor) {
            throw new JEBTypeError(`${theTypeName(typeOf(obj))} is not subscriptable`);
        }
        checkNothingOrPush(vm, accessor.run(vm, [obj], { field, type }));
    },
        `.sed obj name -- lvalue
.param {code} name - evaluated
.throws jeb:type_error - if the object can't be indexed
. Finds an Accessor for the object and pushes the LValue for the given field.`);
    defineOpcode(vm, "jeb:get", (vm, { 0: shouldBind }) => {
        checkNothingOrPush(vm, (vm.popData() as Reference).get(vm, shouldBind))
    },
        `.imm accessType shouldBind
.param {AccessType} accessType
.param {boolean?} [shouldBind=false]
.sed lvalue -- value
. Takes an LValue on the top of the stack and unwraps it by calling its get() method.`);
    defineOpcode(vm, "jeb:set", (vm, { 0: create, 1: readonly }) => {
        const lvalue = vm.popData() as Reference;
        lvalue.set(vm, vm.peekData(), create ?? false, readonly ?? false);
    },
        `.imm accessType create readonly
.param {AccessType} accessType
.param {boolean?} [create=false]
.param {boolean?} [readonly=false]
.sed value lvalue -- value
. Takes an LValue on the top of the stack and calls the \`set()\` method with the next item in the stack as the value to set.`);
    defineBuiltin(vm, "$", ["name"], false, ({ name }, vm) => {
        vm.pushCommand("jeb:wrap", ReferenceWrapper);
        vm.pushCommand("jeb:index", AccessType.VARIABLE);
        vm.pushData(vm.currentEnv);
        return name;
    }, `.func ($ name)
..param {string} name
.throws jeb:reference_error - if the name is not defined anywhere
.returns {any}
. Look up the variable with this name in the current environment.`);
    defineBuiltin(vm, ".", ["obj", "name"], false, ({ obj, name }, vm) => {
        vm.pushCommand("jeb:wrap", ReferenceWrapper);
        vm.pushCommand("jeb:index", AccessType.PROPERTY);
        vm.pushData(obj);
        return name;
    },
        `.func (. obj name)
..param {any} obj
..param {PropertyKey} name
. Returns a reference to the \`obj[name]\`.`);
    defineOpcode(vm, "jeb:set/internal/nested", vm => vm.pushData({ _: vm.popData() }), null);
    defineOpcode(vm, "jeb:set/internal", (vm, { 0: valueExpr, 1: old }) => {
        const lambda = new Lambda(false, true, undefined, ONE_UNDERSCORE_QUOTED, [valueExpr], vm.currentEnv, "");
        // accessor is first on stack
        if (old) vm.pushCommand("jeb:shuffle", 1, []);
        vm.pushCommand("jeb:set");
        vm.pushCommand("jeb:shuffle", 2, [1, 0]);
        vm.pushCommand("jeb:lambda/invoke", lambda, false);
        vm.pushCommand("jeb:set/internal/nested");
        if (old) vm.pushCommand("jeb:shuffle", 2, [1, 0, 1]);
        vm.pushCommand("jeb:get", true);
        vm.pushCommand("jeb:shuffle", 1, [0, 0]);
    }, null);
    defineBuiltin(vm, "set", [[["ref"], "ref"], [true, "value"], ["old", false]], false, ({ ref, value, old }, vm) => {
        if (!isinstance(ref, ReferenceWrapper)) {
            throw new JEBTypeError(`cannot assign to ${theTypeName(typeOf(ref))}`);
        }
        vm.pushCommand("jeb:set/internal", value, old);
        return ref.obj;
    },
        `.macro (set slot value old)
..param {reference} slot
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
..throws jeb:value_error - if the array of names is malformed
.throws jeb:reference_error - if the value is not defined anywhere
.returns {old ? U : T}
. Changes the value of the slot, and returns the new or old value as determined by \`old\`.`);

    // MARK: error handling
    defineOpcode(vm, "jeb:throw", (vm, { 0: err }) => {
        while (vm.curDynamicWind.parent) {
            // call exit handler with error details
            // if it returns true, it means the error was handled and we can continue execution
            const dw = vm.curDynamicWind;
            vm.curDynamicWind = dw.parent!;
            dw.restore(vm);
            if (dw.handler?.exit) {
                vm.pushCommand("jeb:if", null, ["jeb:throw", err], true);
                vm.pushCommand("jeb:apply", [false, err], false, true);
                vm.pushData(dw.handler.exit);
                return;
            }
        }
        // if there's nothing to catch the error, just throw it back to JavaScript
        vm.fatalError(err);
    },
        `.imm err
.param {JEBError} err
.sed -- (does not return)
. Throws the error, but allows [[with]] handlers to catch it before throwing to Javascript.`);
    defineBuiltin(vm, "throw", ["err"], false, ({ err }, vm) => {
        if (!isinstance(err, JEBError)) throw new JEBTypeError("errors must inherit from JEBError");
        throw err;
    },
        `.func (throw err)
..param {JEBError} err
.returns {never}
. Throw an error. If we're inside a [[with]] block, it will trigger the \`exit\` handler of the context object to possibly handle the error.
If the error is not handled, it will be thrown as a Javascript error, causing the program to halt.`);
    defineBuiltin(vm, "err", [["message", "no message"], ["type", ,], ["up", 0]], false, ({ message, type, up }, vm) => new (ALL_ERRORS[type] ?? class extends JEBError { get tag() { return type } })(message, {}, vm.tracebackArray(up)),
        `.func (err message type up)
..param {string?} [message="no message"]
..param {string?} type - type code for error (to look up the correct class)
..param {number?} [up=0] - number of stack frames to drop (in order to e.g. attribute the error to the caller)
. Creates a new error object, but does not actually throw it (use [[throw]] for that).`);
    // MARK: with
    defineBuiltin(vm, "with", [[true, "binding"], "context", [true, "body"], true], false, ({ binding, context, body }, vm) => {
        if (!isString(binding) && binding !== null) {
            throw new JEBTypeError("expected variable name or null as first argument to \"with\"")
        }
        // Capture "from" here so that it doesn't capture the "with/teardown" opcode
        const dw = vm.newDynamicWind();
        // this looks backwards because it is - it's a stack, so the last one pushed (at the bottom)
        // is the first one executed
        vm.pushCommand("jeb:with/teardown");
        implicitBegin(vm, body);
        vm.pushCommand("jeb:with/setup", dw, binding);
        vm.pushData(context);
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
.throws jeb:type_error - if \`varname\` is null or \`handlers\` is not an object.
. Used to manage error handling, contextual resources, and continuation tracking.`);

    defineOpcode(vm, "jeb:with/setup", (vm, { 0: dw, 1: name }) => {
        // we just got the before and after handlers evaluated
        const context = vm.popData() as Windable;
        const notObject = typeof context !== "object" || context === null;
        if (notObject || !("enter" in context || "exit" in context)) {
            throw new JEBTypeError(notObject ? "context manager should be an object" : "context manager should have 'enter' and/or 'exit' handlers");
        }
        dw.setHandler(context);
        // set up the winder to be installed AFTER the enter handler runs, so that errors thrown by this handler won't be caught by the exit handler
        vm.pushCommand("jeb:with/install", dw);

        if (!context.enter) return;
        vm.pushCommand("jeb:shuffle", 1, []);
        if (name !== null) {
            vm.pushCommand("jeb:set", true);
            vm.pushCommand("jeb:shuffle", 2, [1, 0]);
            vm.pushData(new VariableReference(AccessType.VARIABLE, vm.currentEnv, name));
        }
        vm.pushCommand("jeb:apply", [false]);
        vm.pushData(context.enter);
    }, null);

    defineOpcode(vm, "jeb:with/install", (vm, { 0: dw }) => {
        vm.curDynamicWind = dw;
    }, null);

    defineOpcode(vm, "jeb:with/teardown", vm => {
        if (!vm.curDynamicWind.parent) throw new JEBError("Dynamic wind stack underflow");
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        if (!dw.handler?.exit) return;
        // discard the exit handler's result
        vm.pushCommand("jeb:shuffle", 1, []);
        vm.pushCommand("jeb:apply", [false, null]);
        vm.pushData(dw.handler.exit);
    }, null);

    // MARK: FFI
    defineApplier(vm, ["function"], (vm, { 0: f }) => {
        vm.pushCommand("jeb:ffi/invokeFunction", f);
    }, (_, f) => ({
        name: `[JS function ${f.name || "<no name>"}]`,
        signature: ALL_UNDERSCORE_NORMAL,
        macro: (f as any).MACRO ?? false,
    }),
        `JEB's FFI can call Javascript functions. JEB does not check the \`.length\` of the function since it is wrong in some cases.
.throws jeb:ffi_error - if the FFI'ed function throws an error`);
    defineOpcode(vm, "jeb:ffi/invokeFunction", (vm, { 0: f }) => vm.pushData(wrapThrowToError(vm, JEBError, () => f(...vm.popData()._))), null);

    defineBuiltin(vm, "nil?", ["value"], false, ({ value }) => undefinedToNull(value) === null,
        `.func (nil? value)
..param {any} value
.returns {boolean}
. \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might still be falsy.`);

    // MARK: lambda applier
    defineApplier(vm, [Lambda], (vm, { 0: lambda }, { tail }) => vm.pushCommand("jeb:lambda/invoke", lambda, tail),
        (_, lambda) => ({
            name: lambda.isImplicit ? undefined : lambda.name ?? (lambda.isMacro ? "[macro]" : "[lambda]"),
            macro: lambda.isMacro,
            signature: lambda.signature,
            closureEnv: lambda.closureEnv,
        }),
        "\"Compiled\" wrapper for a function or macro defined entirely out of JEB code (which is just JSON).");
    defineOpcode(vm, "jeb:lambda/invoke/resetEnv", (vm, { 0: env }) => vm.currentEnv = env, null);
    defineOpcode(vm, "jeb:lambda/invoke", (vm, { 0: lambda, 1: tail }) => {
        if (!tail) vm.pushCommand("jeb:lambda/invoke/resetEnv", vm.currentEnv);
        const argvObject = vm.popData();
        const callEnv = vm.createEnv(lambda.closureEnv);
        for (var { 0: name, 1: value } of Object.entries(argvObject)) callEnv.add(name, value);
        if (!lambda.isImplicit) callEnv.add("return", vm.cc());
        vm.currentEnv = callEnv;
        return implicitBegin(vm, lambda.body);
    }, null);
    const lambdaHelper = (name: string, isMacro: boolean, kind: string, extra: string) => {
        defineBuiltin(vm, name, [[true, "params"], [true, "body"], true], false, ({ params, body }, vm) => {
            var isImplicit = false;
            if (typeof params === "boolean") {
                isImplicit = params;
                params = body[0];
                body = body.slice(1);
            }
            var docstring = "";
            if (isString(body[0]) && body.length > 1) {
                docstring = body[0];
                body = body.slice(1);
            }
            return new Lambda(isMacro, isImplicit, undefined, wrapThrowToError(vm, JEBSyntaxError, () => createSignature(params)), body, vm.currentEnv, docstring);
        },
            `.macro (${name} (parameters...) body...) (${name} true (parameters...) docstring body...)
The form with \`true\` right after the \`${kind}\` defines it as an implicit ${kind}, where the special \`return\` continuation is not injected and the call will not show up in the traceback of an error (it would normally show as \`[${kind}]\` unless assigned to a name).
..param {...} parameters - list of parameter names and flags
There are many forms that the paremeter can take to control is behavior at call time:
* \`bare string name\` - normal required parameter.
* \`[string name, default]\` - the parameter is optional, and if it is not provided in a call, then the value of \`default\` is evaluated in a dynamic environment of both the environment in which the ${kind} was defined, as well as the environment from which it was called.
* \`[true, string name]\` - defines the parameter to be a macro control parameter; the value the ${kind} body sees is the **unevaluated AST** of the expression instead of the result of evaluating the expression
* \`[false, string name]\` - defines the parameter to be a "lazy" parameter; the value the ${kind} body sees is a [[block]] wrapper object for the expression's unevaluated AST instead
* \`[flags list, string name]\` - normal required parameter, except that return values wrapped with special wrappers matching names in the flags list are **not** unwrapped, allowing the ${kind} body to operate on the wrapper itself directly
* \`[flags list, string name, default]\` - same as above with flags and default semantics
* \`[flags list, false, string name]\` - same as block wrapper form with flags to prevent unwrapping of other types
* \`true\` or \`false\` after a parameter - defines the parameter to be a rest parameter (for \`true\`) or keyword rest parameter (for \`false\`) that will be an array or object at runtime filled with all the positional or keyword arguments given after it. It cannot have a default since defining it as a rest parameter implicitly defines the default as \`[]\` or \`{}\`.
..param {string} docstring - Defines the documentation string for this ${kind}. The first element of the body will only be interpreted as a docstring if there is at least one statement after it (rendering the string otherwise pointless).
..param {code} body... - Statements to be executed in sequence (as with [[begin]]) to calculate the return value of the ${kind}.
...injected {Continuation} return - if the first element after the \`${name}\` is not \`true\`, a continuation jumping back to where the ${kind} was called from is injected into the \`return\` variable.
.returns {Lambda}
. Returns a new anonymous ${kind} with the specified parameters, documentation string, and body.${extra}`);
    }
    lambdaHelper("lambda", false, "function", "");
    lambdaHelper("macro", true, "macro", "\nA macro differs from a normal function in that the return value of the macro is assumed to be an executable AST rather than just data, and is evaluated again the the scope that the macro was called from (and errors arising from this code will say 'expanded from macro [name]' in the traceback).");

    // MARK: continuation applier
    defineApplier(vm, [Continuation], (vm, { 0: k }) => {
        vm.pushCommand("jeb:continuation/invoke", k);
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
    defineOpcode(vm, "jeb:continuation/invoke", (vm, { 0: k }) => k.invoke(vm, vm.popData().value), null);

    // MARK: logic
    defineOpcode(vm, "jeb:if", (vm, { 0: then, 1: else_, 2: isAsm }) => {
        const condition = vm.popData();
        if (isAsm) {
            if (condition) { if (then) vm.pushCommand(...then); } else if (else_) vm.pushCommand(...else_);
        } else {
            vm.pushData(condition ? then : else_);
            vm.pushCommand("jeb:eval", true);
        }
    },
        `.imm then else isAsm
Pops the top stack value, and if it's truthy, evaluates \`then\`, and if it's falsy, evaluates \`else\`.
..param {false?} isAsm
..param {code | null} then
..param {code | null} else
..sed condition -- result
.imm then else isAsm
Pops the top stack value, and if it's truthy, queues \`then\` to be executed as a command, and if it's falsy queues \`else\`.
..param {true} isAsm
..param {Command | null} then
..param {Command | null} else
..sed condition -- ???`);

    // MARK: Scheme analogs
    defineBuiltin(vm, "if", ["condition", [true, "then"], [true, "else", null]], false, ({ condition, then, else: else_ }, vm) => {
        vm.pushCommand("jeb:if", then, else_);
        return condition;
    },
        `.macro (if cond then else)
..param {code} cond - condition; always evaluated
..param {code} then - case to be evaluated if \`cond\` is truthy
..param {code} [else=null] - case to be evaluated if \`cond\` is falsy
.returns {any}`);

    defineBuiltin(vm, "begin", [[true, "body"], true], false, ({ body }, vm) => implicitBegin(vm, body!),
        `.macro (begin body...)
..param {code} body...
.returns {any | null} - null if \`body\` is empty, otherwise returns the result of the last body statement
. Runs each of the body statements in order.`);

    defineBuiltin(vm, "let", [[true, "__args"], true], false, (ao, vm) => {
        const args = ao.__args!;
        if (isString(args[0])) {
            // rewrite (let loop ((x 1) (y 2)) body) to ((lambda (loop) (set! loop (lambda (x y) body)) (loop 1 2)) null)
            const loopname = args[0];
            const bindings = args[1] as [string, any][];
            const body = args.slice(2);
            const params = bindings.map(b => b[0]);
            const initializers = bindings.map(b => b[1]);
            vm.pushData([["lambda", true, [loopname], ["set", ["$", loopname], ["lambda", true, params, ...body]], [loopname, ...initializers]], null]);
        } else {
            // rewrite (let ((x 1) (y 2)) body) to ((lambda (x y) body) 1 2)
            const bindings = args[0] as [string, any][];
            const body = args.slice(1);
            const params = bindings.map(b => b[0]);
            const initializers = bindings.map(b => b[1]);
            vm.pushData([["lambda", true, params, ...body], ...initializers]);
        }
        vm.pushCommand("jeb:eval");
        return NOTHING;
    }, `.macro (let pairs body...)
.macro (let loopname pairs body...)
..param {string} loopname - variable name in which a reference to the entire \`let\` is put. \`let\` just expands to a [[lambda]] expression, and the loopname variable allows \`body\` to recursively call that \`lambda\`.
...receives {(...names: (typeof pairs)[number][1]) => any}
.param {[name: string, expression: code][]} pairs
.param {code} body...
. Each of the pairs' *expression*s will be evaluated in order in the parent environment and the result bound to *name* in the new environment; after all values are bound, the body is evaluated in the new environment.`);

    defineBuiltin(vm, "let-in", ["pairs", true], false, ({ pairs: args }, vm) => {
        if ((args.length & 1) > 0) {
            throw new JEBSyntaxError("let-in should have an even number of arguments");
        }
        var value;
        const newEnv = vm.createEnv(vm.currentEnv);
        for (var i = 0; i < args.length; i += 2) {
            const name = args[i];
            value = args[i + 1];
            if (!isString(name)) {
                throw new JEBSyntaxError("let-in name must be a string");
            }
            newEnv.add(name, value);
        }
        vm.currentEnv = newEnv;
        return value;
    },
        `.func (let-in name value [name value]...)
..param {string} name
..param {any} value
..returns {any} - the last value
. Creates a new environment with the given name-value pairs as its bindings, and switches to it. Everything after this will be in the new environment.
Functions much like [[let]] but with an implicit block after it that continues to the end of the outer block instead of explicit.`);

    defineBuiltin(vm, "define", [[true, "definition"], true], false, (ao, vm) => {
        const args = ao.definition!;
        const name = args[0] as string | string[];
        const setHelper = (name: string, thing: any) => {
            vm.pushCommand("jeb:set", true, true);
            vm.pushCommand("jeb:shuffle", 2, [1, 0]);
            vm.pushCommand("jeb:eval");
            vm.pushData(new VariableReference(AccessType.VARIABLE, vm.currentEnv, name));
            vm.pushData(thing);
        };
        if (typeof name === "boolean" && name && isArray(args[1])) {
            // macro definition: (define true (f x y) body)
            const name2 = args[1];
            const funcName = name2[0] as string;
            const params = name2.slice(1) as string[];
            const body = args.slice(2);
            setHelper(funcName, ["macro", params, ...body]);
        }
        else if (isString(name)) {
            // variable definition: (define x 10)
            setHelper(name, args[1]);
        }
        else if (isArray(name)) {
            // function definition: (define (f x y) body)
            const funcName = name[0] as string;
            const params = name.slice(1) as string[];
            const body = args.slice(1);
            setHelper(funcName, ["lambda", params, ...body]);
        }
        else throw new JEBSyntaxError("invalid define syntax");
        return NOTHING;
    },
        `.macro (define name value)
Defines a simple name=value.
..param {string} name
...receives {T}
..param {T} value
.macro (define (name params...) body...)
Expands into a [[lambda]].
..param {string} name
..param {...} params...
..param {code} body...
.macro (define #t (name params...) body...)
Expands into a [[macro]].
..param {string} name
..param {...} params...
..param {code} body...
. Defines a new constant value in the current scope.`);

    // MARK: Operators
    const mathHelper = (operator: string, op2: "add" | "sub" | "mul" | "matMul" | "div" | "mod" | "pow" | "bitAnd" | "bitOr" | "bitXor", op1: "abs" | "neg" | "inv" | undefined,
        f2: (a: number | bigint, b: number | bigint) => number | bigint,
        num: (x: number) => any,
        big: (x: bigint) => any,
        doc: string,
    ) => {
        defineBuiltin(vm, operator, ["a", ["b", NOTHING]], false, ({ a, b }, vm) => {
            var f: () => Result<any, any>;
            if (b === NOTHING) {
                if (op1 === undefined) {
                    throw new JEBTypeError(`${stringify(op2)} is not defined for one argument`);
                }
                f = () => vm.getProtocol(false, true, op1, [a]).run(vm, [a]);
            } else {
                f = () => vm.getProtocol(false, true, op2, [a, b]).run(vm, [a, b]);
            }
            return wrapThrowToError(vm, JEBTypeError, f).else(e => { throw new JEBTypeError(String(e)); })
        }, `.func (${operator} a [b])
..param {any} a
..param {any?} b
.throws jeb:type_error - if no overload was found for the given argument types
. ${doc}`);
        vm.addProtocol(op2, { type: [["number", "bigint"], ["number", "bigint"]], run: (_, { 0: a, 1: b }) => Ok(f2(a, b)), doc });
        if (op1) {
            vm.addProtocol(op1, { type: [["number"]], run: (_, { 0: a }) => Ok(num(a)), doc });
            vm.addProtocol(op1, { type: [["bigint"]], run: (_, { 0: a }) => Ok(big(a)), doc });
        }
    }
    mathHelper("+", "add", "abs", numberOp(add), Math.abs, a => a > 0 ? a : -a, "Adds numbers or concatenates strings.");
    vm.addProtocol("add", { type: [["string"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(a + b), doc: "Concatenates strings" });
    mathHelper("-", "sub", "neg", numberOp((a, b) => a - b), a => -a, a => -a, "Subtracts numbers.\nIn the case of one number, returns the additive inverse (i.e. the negative).");
    mathHelper("*", "mul", undefined, numberOp((a, b) => a * b), id, id, "Multiplies numbers.\nThe special case of `string * number` or `number * string` results in repeating the string N times.");
    const repeat = (a: string, b: number): Result<string, string> => {
        if (b < 0) return Err("Cannot repeat a negative number of times");
        if ((b | 0) !== b) return Err("Cannot repeat a non-integer number of times");
        return Ok(a.repeat(b));
    };
    vm.addProtocol("mul", { type: [["string"], ["number"]], run: (_, { 0: a, 1: b }) => Ok(repeat(a, b)), doc: "Repeats strings" });
    vm.addProtocol("mul", { type: [["number"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(repeat(b, a)), doc: "Repeats strings" });
    mathHelper("/", "div", "inv", (a, b) => float(a) / float(b), a => 1 / a, a => 1 / float(a), "Divides numbers.\nIn the case of one number, returns the multiplicative inverse (i.e. the reciprocal).");
    mathHelper("%", "mod", undefined, numberOp((a, b) => a % b), id, id, "Computes the modulo of two numbers.");
    mathHelper("pow", "pow", undefined, numberOp((a, b) => a ** b), id, id, "Computes the power of numbers.\nHowever, this function still folds from the right like the other math functions, so unlike how power is notated mathematically (where `a^b^c^d^e` means `a^(b^(c^(d^e)))`), `[\"pow\", a, b, c, d, e]` is interpreted as `(((a^b)^c)^d)^e`.");
    mathHelper("bit-and", "bitAnd", undefined, numberOp((a, b) => a & b), id, id, "Computes the bitwise AND of all numbers.");
    mathHelper("bit-or", "bitOr", undefined, numberOp((a, b) => a | b), id, id, "Computes the bitwise OR of all numbers.");
    mathHelper("bit-xor", "bitXor", undefined, numberOp((a, b) => a ^ b), id, id, "Computes the bitwise XOR of all numbers.");
    defineBuiltin(vm, "bit-inv", ["a"], false, ({ a }) => ~a, `.func (bit-inv number)
..param {number} a
. Computes the two's complement signed bitwise inverse of the number.`);

    // comparisons
    const comparisonHelper = (op: string, bits: Relation, doc: string) => {
        defineBuiltin(vm, op, ["items", true], false, ({ items: a }, vm) => {
            if (a.length < 2) return true;
            for (var i = 1; i < a.length; i++) {
                const arg = [a[i - 1], a[i], bits] as [any, any, Relation];
                const res = wrapThrowToError(vm, JEBTypeError, () => vm.getProtocol(false, true, "cmp", arg).run(vm, arg));
                if (!res.ok) {
                    throw new JEBTypeError("comparison error: " + res.error, { return: vm.cc() });
                }
                if (!res.data) return false;
            }
            return true;
        },
            `.func (${op} items...)
..param {number | string} items...
. ${doc}`);
    }
    const compDocHelper = (phrase: string) => `True if the sequence of items is strictly ${phrase} when read from left to right.`;
    for (var [name, bits, doc] of ([
        ["=", Relation.EQUAL, "True if all of the items are equal."],
        ["!=", Relation.NOT_EQ, "True if no adjacent pair of items are equal."],
        ["<", Relation.LESS, compDocHelper("increasing")],
        [">", Relation.GREATER, compDocHelper("decreasing")],
        ["<=", Relation.LESS_EQ, compDocHelper("nondecreasing")],
        [">=", Relation.GREATER_EQ, compDocHelper("nonincreasing")],
    ] as [string, Relation, string][])) {
        comparisonHelper(name, bits, doc);
    }
    const compareFn = (_: JebVM, { 0: a, 1: b, 2: c }: [any, any, Relation]) => {
        if (a == b) return Ok(!!(c & Relation.EQUAL));
        if (a < b) return Ok(!!(c & Relation.LESS));
        if (a > b) return Ok(!!(c & Relation.GREATER));
        throw "unreachable";
    };
    vm.addProtocol("cmp", { type: [["number", "bigint"], ["number", "bigint"], ["number"]], run: compareFn, doc: "Compares numbers" });
    vm.addProtocol("cmp", { type: [["string"], ["string"], ["number"]], run: compareFn, doc: "Compares strings" });
    vm.addProtocol("cmp", {
        type: [[true], [true], ["number"]],
        run(_, { 0: a, 1: b, 2: c }) {
            if (a === b) return Ok(!!(c & Relation.EQUAL));
            if ((!!(c & Relation.GREATER)) !== (!!(c & Relation.LESS))) return Err(`No ordering defined for ${theTypeName(typeOf(a))} and ${theTypeName(typeOf(b))}`);
            return Ok(!!(c & Relation.LESS));
        },
        doc: "Compares any items"
    });

    // MARK: booleans
    defineBuiltin(vm, "not", ["value"], false, ({ value }) => !value, `.func (not value)
..param {any} value
.returns {boolean} - True if \`value\` is falsy (false, zero, undefined, null, or empty string), false otherwise.
. Boolean inverse.`);
    const booleanHelper = (name: string, shortCircuitOn: boolean) => {
        defineBuiltin(vm, name, ["a", [true, "b"]], false, ({ a, b }, vm: JebVM) => {
            if ((!!a) === shortCircuitOn) return a;
            vm.pushData(b);
            vm.pushCommand("jeb:eval", true);
            return NOTHING;
        }, `.macro (${name} a b)
..param {any} values...
. Boolean ${name.toUpperCase()} (short-circuits).
Evaluates \`a\`, if the result is ${shortCircuitOn ? "truthy" : "falsy"}, returns it, otherwise evaluates \`b\` and returns that.`);
    }
    booleanHelper("and", false);
    booleanHelper("or", true);

    // MARK: lists
    defineBuiltin(vm, "list", ["values", true], false, ({ values }) => values, `.func (list values...)
..param {T} values...
.returns {T[]}
. Returns the arguments in a list.`);
    defineBuiltin(vm, "head", ["list"], false, ({ list }) => list[0], `.func (head list)
..param {T[]} list
.returns {T} - The first element in the list`);
    defineBuiltin(vm, "tail", ["list"], false, ({ list }) => list.slice(1), `.func (tail list)
..param {T[]} list
..returns {T[]} - A copy of the list without the first element`);
    defineBuiltin(vm, "concat", ["lists", true], false, ({ lists }) => {
        const out: any[] = [];
        for (var arg of lists) {
            try {
                out.push(...arg);
            } catch (e) {
                throw new JEBTypeError(String(e), { cause: e });
            }
        }
        return out;
    }, `.func (concat lists...)
..param {T[]} lists...
If an argument is not a list, the value is coerced to a list using the Javascript \`...\` spread operator.
.returns {T[]}
. Concatenates the lists, and returns a new list.`)

    // MARK: metaprogramming
    defineBuiltin(vm, "quote", [[true, "expr"]], false, ({ expr }) => expr, `.macro (quote expr) | (' expr) | 'expr
..param {code} expr
.returns {code}
. Prevents its argument from being evaluated.`);
    alias(vm, "quote", "'");
    defineBuiltin(vm, "quasiquote", [[true, "value"]], true, ({ value }, vm) => processQuasiquote(vm, value, 1),
        `.macro (quasiquote value) | (~ value) | ~value
..param {any} value
.returns {any}
. Prevents \`value\` from being evaluated, but walks the elements and replaces [[unquote]] and [[unquoteSplicing]] with the results of evaluating their arguments. The argument to [[unquoteSplicing]] must be a list.`);
    alias(vm, "quasiquote", "~");

    defineBuiltin(vm, "unquote", [[true, "value"]], false, (_, vm) => { throw new JEBSyntaxError("unquote" + " not valid outside of quasiquote", { return: vm.cc() }); },
        `.macro (unquote value) | (, value) | ,value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a value to be interpolated inside a [[quasiquote]].`);
    defineBuiltin(vm, "unquoteSplicing", [[true, "value"]], false, (_, vm) => { throw new JEBSyntaxError("unquoteSplicing" + " not valid outside of quasiquote", { return: vm.cc() }); },
        `.macro (unquoteSplicing value) | (,@ value) | ,@value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a list to be interpolated via splicing inside a [[quasiquote]].`);
    alias(vm, "unquote", ",");
    alias(vm, "unquoteSplicing", ",@");

    defineBuiltin(vm, "parseJSON", ["json"], false, ({ json }, vm) => wrapThrowToError(vm, JEBValueError, () => parse(json)),
        `.func (parseJSON json)
..param {string} json
.throws jeb:value_error - if the string is not valid JSON
.returns {any}
. Parses the string using \`JSON.parse()\` and returns the object.`);
    defineBuiltin(vm, "dumpJSON", ["value"], false, ({ value }, vm) => wrapThrowToError(vm, JEBValueError, () => stringify(value)),
        `.func (dumpJSON value)
..param {any} value
.throws jeb:value_error - if \`value\` contains something that can't be serialized, such as a function or circular reference
.returns {string}
. Stringifies the object to JSON using \`JSON.stringify()\`.`);
}
// MARK: end of loadBuiltins();



// MARK: processQuasiquote
const processQuasiquote = (vm: JebVM, form: any, depth: number): any => {
    const env = vm.currentEnv;
    // atoms
    if (!isArray(form)) {
        if (typeof form !== "object" || form === null) {
            return form;
        } else {
            const newObj: Record<string, any> = {};
            for (var [key, value] of Object.entries(form)) {
                newObj[key] = processQuasiquote(vm, value, depth);
            }
            return newObj;
        }
    }
    if (form.length === 0) return ["list"];

    const { 0: head, 1: arg } = form;

    const same = (x: any, y: string) => {
        if (!isString(x)) return false;
        const v1 = env.get(x);
        const v2 = env.get(y);
        return v1.ok ? (v2.ok && v1.data === v2.data) : !v2.ok;
    }

    // ,x
    if (same(head, "unquote")) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquote");
        return depth === 1 ? arg : ["list", "unquote", processQuasiquote(vm, arg, depth - 1)];
    }
    // ,@x
    if (same(head, "unquoteSplicing")) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquoteSplicing");
        if (depth !== 1) return ["list", "unquoteSplicing", processQuasiquote(vm, arg, depth - 1)];
        throw new JEBSyntaxError("unquoteSplicing outside of list");
    }
    // nested `
    if (same(head, "quasiquote")) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to quasiquote");
        return ["list", "quasiquote", processQuasiquote(vm, arg, depth + 1)];
    }

    // list – collect chunks, splice where needed
    const parts: any[] = [];
    const buffer: any[] = [];

    const flush = () => {
        if (buffer.length) {
            const part = ["list"];
            for (var e of buffer) {
                part.push(processQuasiquote(vm, e, depth));
            }
            parts.push(part);
            buffer.length = 0;
        }
    };

    for (var el of form) {
        if (!isArray(el) || depth !== 1) {
            buffer.push(el);
        }
        else if (same(el[0], "unquoteSplicing")) {
            if (el.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquoteSplicing");
            flush();
            parts.push(el[1]); // ,@x → will be spliced by concat
        } else {
            buffer.push(el);
        }
    }
    flush();

    if (parts.length === 0) return ["list"];
    if (parts.length === 1) return parts[0];
    // (concat part1 part2...)
    return ["concat"].concat(parts);
}

const ONE_UNDERSCORE_QUOTED: CallableSignature = {
    params: [{
        name: "_",
        required: false,
        flags: [],
        defaultExpr: undefined,
        lazy: Laziness.QUOTED,
    }],
    rest: undefined,
    kwRest: undefined,
};

const ALL_UNDERSCORE_QUOTED: CallableSignature = {
    params: [],
    rest: {
        name: "_",
        required: false,
        flags: [],
        defaultExpr: undefined,
        lazy: Laziness.QUOTED,
    },
    kwRest: undefined,
};

const ALL_UNDERSCORE_NORMAL: CallableSignature = {
    params: [],
    rest: {
        name: "_",
        required: false,
        flags: [],
        defaultExpr: undefined,
        lazy: Laziness.NONE,
    },
    kwRest: undefined,
};

// MARK: JSON based standard library!
// const STANDARD_LIBRARY = ["begin",
//     ["define", true, ["comment", "items", true],
//         `.macro (comment items...) | (#; items...) | #;(items...)
// ..param {any} items
// .returns {null}
// . Skips evaluating the items and returns null immediately.`,
//         null],
//     ["define", "#;", ["$", "comment"]],
//     ["define", true, ["uncomment", "items", true],
//         `.macro (uncomment items...) | (!; items...) | !;(items...)
// ..param {code} items
// . Evaluates the items as with [[begin]].`,
//         ["quasiquote", ["begin", ["unquoteSplicing", ["$", "items"]]]]],
//     ["define", "!;", ["$", "uncomment"]],
//     ["define", ["call-with-current-continuation", "f"],
//         `.func (call-with-current-continuation f) | (cwcc f)
// ..param {(k: Continuation) => any} f
// .returns {any} - possibly multiple times if the continuation is invoked later
// . Calls the function with a *continuation*, which is a special callable object. When the continuation is called with one argument, it will not return normally, and instead jump back to the place where \`cwcc\` was created from and make the \`cwcc\` return the given value instead - *even if* the \`cwcc\` expression has already returned!
// Invoking a continuation will cause the \`enter\` and \`exit\` handlers of [[with]] blocks jumped across to be triggered with \`true\` to indicate it was due to a continuation.
// Continuations can be used for very complex control structures and can be incredibly confusing to debug, so use with care.`,
//         ["f", ["$", "return"]]],
//     ["define", "cwcc", ["$", "call-with-current-continuation"]],
//     ["define", true, ["when", "test", "body", true],
//         `.macro (when test body...)
// ..param {boolean} test
// ..param {code => T} body
// .returns {T | null}
// . If \`condition\` is truthy, runs \`body\` as with [[begin]].
// (Equivalent to \`([[if]] condition ([[begin]] body...))\`.)`,
//         ["quasiquote",
//             ["if", ["unquote", ["$", "test"]],
//                 ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
//     ["define", true, ["unless", "test", "body", true],
//         `.macro (unless test body...)
// ..param {boolean} test
// ..param {code => T} body
// .returns {T | null}
// . If \`condition\` is falsy, runs \`body\` as with [[begin]].
// (Equivalent to \`([[when]] ([[not]] condition) body...)\`.)`,
//         ["quasiquote",
//             ["if", ["unquote", ["$", "test"]],
//                 null,
//                 ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
//     ["define", true, ["try", "body", "handlers"],
//         `.macro (try body handlers)
// ..param {code} body - single statement that forms the body. If you need more than one statement, use [[begin]].
// ..param {object} handlers
// ...prop {(message: string, context: object) => ignored} (name) - called for the error with \`type\` equal to \`name\` (where \`name\` is the property name of the object).
// ...prop {(type: string, message: string, context: object) => ignored} * - called if an error is thrown, but no specific handler matched it
// ...prop {() => ignored} else - called if no error is thrown
// . Catches and handles errors.
// During evaluation of the body, if an error is thrown, the error's \`type\` (as returned by [[with]]) will be checked to see if it's in the handlers, and if it is, the handler is called with the \`message\` and \`context\` of the error.
// If no handler directly matches, the special catch-all handler \`"\\*"\` is tried.
// In both cases if the handler exists, \`true\` is returned to [[with]] to stop propagation of the error. If the handler wants to propagate the error, it should re-throw it using [[error]].`,
//         ["quasiquote", ["let", [["handlers", ["unquote", ["$", "handlers"]]]],
//             ["with", null, {
//                 exit: ["lambda", ["k", "type", "message", "ctx"],
//                     ["let",
//                         [
//                             ["handler", ["$", ["handlers", ["$", "type"]]]],
//                             ["starHandler", ["$", ["handlers", "*"]]],
//                             ["elseHandler", ["$", ["handlers", "else"]]]
//                         ],
//                         ["unless", ["$", "type"],
//                             ["when", ["$", "elseHandler"], ["elseHandler"]],
//                             ["return", true]],
//                         ["when", ["$", "handler"],
//                             ["handler", ["$", "message"], ["$", "ctx"]],
//                             ["return", true]],
//                         ["when", ["$", "starHandler"],
//                             ["starHandler", ["$", "type"], ["$", "message"], ["$", "ctx"]],
//                             ["return", true]],
//                         false]],
//             },
//                 ["unquote", ["$", "body"]]]]]],
//     ["define", true, ["with-baffle", "body", true],
//         `.macro (with-baffle body...)
// ..param {code} body... - evaluated as with [[begin]]
// .throws jeb:state_error - if a continuation tries to jump in or out.
// . Prevents continuations from jumping in or out of \`body\`; only normal control flow or exceptions can be used to enter or exit.`,
//         ["quasiquote", ["with", null, {
//             enter: ["lambda", ["k"],
//                 ["when", ["$", "k"],
//                     ["error", "jeb:state_error", "Continuation tried to jump into a 'with-baffle' block", {}]],
//                 null],
//             exit: ["lambda", ["k", "_", true],
//                 ["when", ["$", "k"],
//                     ["error", "jeb:state_error", "Continuation tried to jump out of a 'with-baffle' block", {}]],
//                 false]
//         },
//             ["unquoteSplicing", ["$", "body"]]]]],
//     ["define", ["length", "x"], `.func (length value)
// ..param {any[] | string} value
// .returns {number} - the length of \`value\``,
//         ["$", ["x", "length"]]],
//     ["define", ["zero?", "x"], `.func (zero? value)
// ..param {number} value
// .returns {boolean} - true if \`value\` is zero`,
//         ["=", ["$", "x"], 0]],
//     ["define", true, ["|>", "value", "items", true],
//         `.macro (|> value expressions...)
// ..param {any} value
// ..param {code} expressions...
// ...injected {any} %
// . Pipes the \`value\` as the variable \`%\` into the next expression, and then the result of it becomes the next \`%\`, etc. until all expressions have been evaluated.
// This is analogous to Javascript's proposed pipe operator, specifically the Hack style.`,
//         ["if", ["zero?", ["length", ["$", "items"]]],
//             ["$", "value"],
//             ["quasiquote",
//                 [["lambda", true, ["%"],
//                     ["|>", ["unquoteSplicing", ["$", "items"]]]],
//                 ["unquote", ["$", "value"]]]]]],
//     ["define", ["reduce", "list", "f", "value"],
//         `.func (reduce list function value)
// ..param {T[]} list
// ..param {(value: R, item: T) => R} function
// ..param {R} value
// .returns {R}
// . Repeatedly call the function with 2 arguments; the first one is the current \`value\` and the second is each element of \`list\` in turn. The return value will be the new \`value\` for the next element.
// When the list is empty, returns the accumulated value.`,
//         ["if", ["zero?", ["length", ["$", "list"]]],
//             ["$", "value"],
//             ["reduce",
//                 ["tail", ["$", "list"]],
//                 ["$", "f"],
//                 ["f", ["$", "value"], ["head", ["$", "list"]]]]]],
//     ["define", ["map", "list_", "f"],
//         `.func (map list function)
// ..param {T[]} list
// ..param {(x: T) => R} function
// .returns {R[]}
// . Return a new list with the result of applying the function to each element of the list in order.`,
//         ["reduce",
//             ["$", "list_"],
//             ["lambda", ["acc", "cur"],
//                 ["concat", ["$", "acc"], ["list", ["f", ["$", "cur"]]]]],
//             ["list"]]],
//     ["define", true, ["while", "cond", "body", true],
//         `.macro (while cond body...)
// ..param {code => boolean} cond
// ..param {code} body
// . Evaluates \`cond\` repeatedly, followed by \`body\`, until \`cond\` evaluates to a falsy value and then returns null.`,
//         ["quasiquote", ["when",
//             ["unquote", ["$", "cond"]],
//             ["unquoteSplicing", ["$", "body"]],
//             ["while", ["unquote", ["$", "cond"]], ["unquoteSplicing", ["$", "body"]]]]]],
// ];

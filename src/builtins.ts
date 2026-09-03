import { isinstance } from "@r47onfire/game-math";
import { isArray } from "lib0/array";
import { undefinedToNull } from "lib0/conditions";
import { id, isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { add } from "lib0/math";
import { Err, Ok, Result } from "ts-res";
import { JEBAuditEvent } from "./auditHookTypes";
import { Block } from "./block";
import { Fun, JSFun } from "./callable";
import { Continuation, DynamicWind, Windable } from "./continuation";
import { define, defineAccessor, defineApplier, defineEvaluator, makeJSFun, makeOpcode, NOTHING } from "./define";
import { OP_doargs } from "./doargs";
import { Env, gensym } from "./env";
import { ALL_ERRORS, checkNothingOrPush, JEBError, JEBSyntaxError, JEBTypeError, JEBValueError, Location, wrapThrowToError } from "./errors";
import { implicitBegin } from "./implicitBegin";
import { __initializer } from "./initializers";
import { float, numberOp, Relation } from "./math";
import { AccessType, Reference, theTypeName, typeOf } from "./protocol";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { CallableSignature, createSignature, Laziness, LonghandArgument } from "./signature";
import { OP_unwrap, OP_wrap } from "./unwrap";
import { Identifier, isIdentifier } from "./utils";
import { Command, JebVM, peekData, popData, popNData, pushCommand, pushData } from "./vm";
import { KeywordArg, MacroWrapper, ReferenceWrapper, SplatArg } from "./wrapper";

export const OP_audit = makeOpcode((vm: JebVM, args: JEBAuditEvent<any>) => {
    vm.audit(...args);
},
    `.imm name args...
..param {keyof JEBAuditEvents} name
..param {any[]} args
. Raises an auditing event with the given arguments.`);

export const B_audit = makeJSFun("audit", ["event", "params", true], ({ event, params }, vm) => vm.audit(event, ...params),
    `.func (audit event params...)
..param {keyof JEBAuditEvents} event
..param {any[]} params
. Raises an auditing event with the given arguments.`);


// MARK: op: traceback push/pop
export const OP_tbPop = makeOpcode(vm => vm.popTraceback(),
    `.imm
.sed --
. Pops the top of the traceback stack, including all tailcall entries if there are some.`);
export const OP_tbPush = makeOpcode((vm: JebVM, { 0: func, 1: location, 2: tail }: [f: Identifier | undefined, Location | undefined, tail?: boolean]) => vm.pushTraceback(func, tail ?? false, location),
    `.imm function tailcall
..param {string} function
..param {boolean} [tailcall=false]
. Pushes the function to the traceback stack.`);

// MARK: op: stack shuffle
export const OP_shuffle = makeOpcode((vm: JebVM, { 0: n, 1: indices }: [number, number[]]) => {
    const items = popNData(vm, n), len = indices.length;
    for (var i = 0; i < len; i++) {
        pushData(vm, items[indices[i]!]!);
    }
},
    `.imm count indices
..param {number} count
..param {number[]} indices
. Pops \`count\` items off the stack, and then pushes the items back on in the order defined by \`indices\`.
Examples:
* \`N/[0, 1, 2, 3, ..., N-1]\` = identity
* \`2/[1, 0]\` = swap
* \`1/[]\` = drop
* \`1/[0, 0]\` = dup
* \`N/[1, 2, 3, 4, ..., N-1, 0]\` = N-tuck`);

// MARK: eval
export const OP_eval = makeOpcode((vm: JebVM, { 0: location, 1: tail }: [Location | undefined, tail?: boolean]) => {
    const code = popData(vm);
    const p = vm.getProtocol(true, false, "eval", [code]);
    if (p) p.run(vm, [code], { tail: tail ?? false, location });
    else pushData(vm, code);
},
    `.imm tailcall
..param {boolean?} [tailcall=false]
.sed value -- evaled
. Evaluates the top item of the stack. An array gets interpreted as a call and passed to [[jeb:apply]], an object has all its properties evaluated and reassembled, and anything else is treated as a literal and left as-is.`);
export const B_eval = makeJSFun("eval", ["arg"], ({ arg }, vm, location) => { pushData(vm, arg); pushCommand(vm, OP_eval, location); return NOTHING; },
    `.func (eval arg)
..param {code} arg
.returns {any}
. Evaluates \`arg\` in the current environment.`);

export const B_macro_wrap = makeJSFun("macro", ["code"], ({ code }) => new MacroWrapper(code),
    `.func (macro code)
..param {code} code
. Wraps the code in a special object that causes it to be evaluated using [[eval]] in the scope of where it was used and the result of the evaluation used in place of the actual code object.
This can be used to create an unhygienic syntactic macro by returning the wrapper immediately.`)

__initializer(vm => defineEvaluator(vm, ["object"], (vm, { 0: code }, { location }) => {
    if (code === null) {
        pushData(vm, null);
        return;
    }
    // evaluate all the properties
    const target = {};
    pushData(vm, target);
    const keys = Reflect.ownKeys(code), len = keys.length;
    for (var i = 0; i < len; i++) {
        pushData(vm, new ObjectPropertyReference(AccessType.PROPERTY, target, keys[i]!));
        pushData(vm, code[keys[i]!]);
        pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_set, true);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_eval, location);
    }
},
    "Evaluates all of the property values, and then reassembles the object with the same set of keys with the evaluated values."));
const arrayEval = (vm: JebVM, code: any[], tail: boolean, location: Location | undefined) => {
    pushCommand(vm, OP_apply, code.slice(1), location, tail);
    pushCommand(vm, OP_unwrap, []);
    pushCommand(vm, OP_eval, location);
    pushData(vm, code[0]);
};
__initializer(vm => {
    defineEvaluator(vm, [Array], (vm, { 0: code }, { tail, location }) => {
        if (code.length > 0) {
            arrayEval(vm, code, tail, location);
        }
        else {
            throw new JEBValueError("can't evaluate empty array", { return: vm.cc() });
        }
    },
        `Calls the first item as a function.
.throws jeb:type_error - if the first item is not callable
.throws jeb:value_error - if the list is empty`);

    defineEvaluator(vm, [JSFun], (vm, { 0: f }) => pushData(vm, f),
        "Builtin functions evaluate to themselves.");

    defineEvaluator(vm, [Fun], (vm, { 0: f }) => pushData(vm, f),
        "Lambda functions evaluate to themselves.");

    defineEvaluator(vm, [Block], (vm, { 0: f }) => pushData(vm, f),
        "Implicit blocks evaluate to themselves.")
});

// MARK: apply
export const OP_apply = makeOpcode((vm: JebVM, { 0: argv, 1: location, 2: tail, 3: noEval }: [any[], location?: Location, tail?: boolean, noEval?: boolean]) => {
    const func = popData(vm);
    const applier = vm.getProtocol(true, false, "apply", [func]);
    if (!applier) {
        throw new JEBTypeError(`can't call ${theTypeName(typeOf(func))}`, { return: vm.cc() });
    }
    const { name, signature, closureEnv } = applier.describe(vm, func);
    if (name && !tail) pushCommand(vm, OP_tbPop);
    applier.run(vm, [func], { tail: tail ?? false, location });
    if (name) pushCommand(vm, OP_tbPush, name, location, tail);
    pushCommand(vm, OP_doargs, signature, closureEnv, noEval ?? false, name);
    pushData(vm, argv);
},
    `.imm expressions tailcall
..param {code[]} expressions
..param {boolean?} [tailcall=false]
.sed functor -- result
.throws jeb:type_error - when the object is not callable
.throws jeb:value_error - when the argument count is wrong
. Pops the top value from the stack and calls it with the provided arguments.
The arguments expressions are expected to be unevaluated, and the signature of the thing being called will determine whether the argument given is evaluated or not.
The \`callAt\` frame will be hidden in the actual traceback.`);
export const B_atLocation = makeJSFun("at", ["start", "end", [true, "expr"]], ({ start, end, expr }, vm) => {
    // Remove self frame from here
    vm.popTraceback(false); // don't drop tail call, just in case this is in tail position
    vm.popCommand(); // This will be the tb_pop pushed by apply above
    pushCommand(vm, OP_eval, [start, end, vm.getCurrentFile()]);
    return expr;
},
    `.macro (at location expr)
..param {opaque-id} location
..param {code} expr
. Equivalent to \`expr\` as a normal [[eval]]uation, but inserts the metadata of \`location\` into the stack frame to identify the call site itself instead of just the thing that was called.`);
export const B_splat = makeJSFun("splat", ["value", ["kw", false]], ({ value, kw }) => new SplatArg(value, kw),
    `.func (splat arg kw)
..param {any[] | object} arg - iterable or object to unpack
..param {boolean?} [kw=false] - whether to unpack into positional or keyword arguments
. Causes the value to unpack into keyword or positional arguments instead of being passed as a single value.`);
export const B_keyword = makeJSFun("kw", ["name", "value"], ({ name, value }) => new KeywordArg(value, name),
    `.func (kw name value)
..param {string} name - name of keyword arg to unpack into
..param {any} value
. Redirects the argument into a particular named argument slot.`);

// MARK: string applier
const OP_apply_id_trampoline = makeOpcode((vm: JebVM, { 0: tail, 1: location }: [boolean | undefined, Location | undefined]) => {
    const realFunc = popData(vm);
    const argsObj = popData(vm) as { _: any[] };
    pushData(vm, realFunc);
    pushCommand(vm, OP_apply, argsObj._, location, tail);
}, null);
__initializer(vm => {
    defineApplier(vm, ["string", "symbol"], (vm, { 0: func }, { tail, location }) => {
        // String is a special case because normally strings evaluate to themselves
        // (not to a callable function), but if it's in head position, we implicitly look it up.
        pushCommand(vm, OP_apply_id_trampoline, tail, location);
        pushCommand(vm, OP_tbPop);
        pushCommand(vm, OP_unwrap, []);
        pushCommand(vm, OP_get, false);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_tbPush, undefined, location);
        pushData(vm, new VariableReference(AccessType.FUNCTION, vm.currentEnv, func));
    }, () => ({
        name: undefined,
        signature: ALL_UNDERSCORE_QUOTED,
        macro: false,
    }),
        `Applying a string is shorthand for looking up the variable with the same name as the string and calling that instead.
As a consequence, \`('foo)\` is the same as \`(foo)\` in JEB even though the former would be invalid in conventional Lisp.`);
    // MARK: builtin applier
    defineApplier(vm, [JSFun],
        (vm, { 0: func }, { location }) => pushCommand(vm, OP_JSFun_invoke, func, location),
        (_, func) => func,
        "Wrapper for a Javascript function that gives it a few properties to make it easier for JEB to call it.");
});
const OP_JSFun_invoke = makeOpcode((vm: JebVM, { 0: func, 1: location }: [JSFun, loc?: Location | undefined]) => checkNothingOrPush(vm, func.impl(popData(vm), vm, location)), null);

// MARK: variables
__initializer(vm => {
    defineAccessor(vm, ["object", "function"], (_, { 0: object }, { field, type }) => new ObjectPropertyReference(type, object, field), "Default object property accessor.");
    defineAccessor(vm, [Env], (_, { 0: env }, { field, type }) => new VariableReference(type, env, field as Identifier), "Accessor for variables from an environment.");
});
export const OP_index = makeOpcode((vm: JebVM, { 0: type }: [AccessType]) => {
    const field = popData(vm) as PropertyKey;
    const obj = popData(vm);
    const accessor = vm.getProtocol(true, false, "access", [obj]);
    if (!accessor) {
        throw new JEBTypeError(`${theTypeName(typeOf(obj))} is not subscriptable`);
    }
    checkNothingOrPush(vm, accessor.run(vm, [obj], { field, type }));
},
    `.sed obj name -- lvalue
..param {code} name - evaluated
.throws jeb:type_error - if the object can't be indexed
. Finds an Accessor for the object and pushes the LValue for the given field.`);
export const OP_get = makeOpcode((vm: JebVM, { 0: shouldBind }: [boolean]) => {
    checkNothingOrPush(vm, (popData(vm) as Reference).get(vm, shouldBind))
},
    `.imm accessType shouldBind
..param {AccessType} accessType
..param {boolean?} [shouldBind=false]
.sed lvalue -- value
. Takes an LValue on the top of the stack and unwraps it by calling its get() method.`);
export const OP_set = makeOpcode((vm: JebVM, { 0: create, 1: readonly }: [create?: boolean, readonly_?: boolean]) => {
    const lvalue = popData(vm) as Reference;
    lvalue.set(vm, peekData(vm), create ?? false, readonly ?? false);
},
    `.imm accessType create readonly
..param {AccessType} accessType
..param {boolean?} [create=false]
..param {boolean?} [readonly=false]
.sed value lvalue -- value
. Takes an LValue on the top of the stack and calls the \`set()\` method with the next item in the stack as the value to set.`);
const B_dollar = makeJSFun("$", ["name"], ({ name }, vm) => {
    pushCommand(vm, OP_wrap, ReferenceWrapper);
    pushCommand(vm, OP_index, AccessType.VARIABLE);
    pushData(vm, vm.currentEnv);
    return name;
},
    `.func ($ name)
..param {string} name
.throws jeb:reference_error - if the name is not defined anywhere
.returns {any}
. Look up the variable with this name in the current environment.`);
export const B_dot = makeJSFun(".", ["obj", "name"], ({ obj, name }, vm) => {
    pushCommand(vm, OP_wrap, ReferenceWrapper);
    pushCommand(vm, OP_index, AccessType.PROPERTY);
    pushData(vm, obj);
    return name;
},
    `.func (. obj name)
..param {any} obj
..param {PropertyKey} name
. Returns a reference to \`obj[name]\`.`);
const OP_set_internal_nested = makeOpcode(vm => pushData(vm, { _: { _: popData(vm) } }), null);
const OP_set_internal = makeOpcode((vm: JebVM, { 0: b, 1: old }: [Block, boolean]) => {
    // accessor is first on stack
    if (old) pushCommand(vm, OP_shuffle, 1, []);
    pushCommand(vm, OP_set);
    pushCommand(vm, OP_shuffle, 2, [1, 0]);
    pushCommand(vm, OP_block_invoke, b, false);
    pushCommand(vm, OP_set_internal_nested);
    if (old) pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
    pushCommand(vm, OP_get, true);
    pushCommand(vm, OP_shuffle, 1, [0, 0]);
}, null);
export const B_set = makeJSFun("set", [[["ref"], "ref"], [false, "value"], ["old", false]], ({ ref, value, old }, vm) => {
    if (!isinstance(ref, ReferenceWrapper)) {
        throw new JEBTypeError(`cannot assign to ${theTypeName(typeOf(ref))}`);
    }
    pushCommand(vm, OP_set_internal, value, old);
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
export const OP_throw = makeOpcode((vm: JebVM, { 0: err }: [JEBError]) => {
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
    // if there's nothing to catch the error, just throw it back to JavaScript
    vm.fatalError(err);
},
    `.imm err
..param {JEBError} err
.sed -- (does not return)
. Throws the error, but allows [[with]] handlers to catch it before throwing to Javascript.`);
export const B_throw = makeJSFun("throw", ["err"], ({ err }) => {
    if (!isinstance(err, JEBError)) throw new JEBTypeError("errors must inherit from JEBError");
    throw err;
},
    `.func (throw err)
..param {JEBError} err
.returns {never}
. Throw an error. If we're inside a [[with]] block, it will trigger the \`exit\` handler of the context object to possibly handle the error.
If the error is not handled, it will be thrown as a Javascript error, causing the program to halt.`);
export const B_err = makeJSFun("err", [["message", "no message"], ["type", ,], ["up", 0]], ({ message, type, up }, vm) => new (ALL_ERRORS[type] ?? class extends JEBError { get tag() { return type } })(message, {}, vm.tracebackArray(up)),
    `.func (err message type up)
..param {string?} [message="no message"]
..param {string?} type - type code for error (to look up the correct class)
..param {number?} [up=0] - number of stack frames to drop (in order to e.g. attribute the error to the caller)
. Creates a new error object, but does not actually throw it (use [[throw]] for that).`);
// MARK: with
export const B_with = makeJSFun("with", [[true, "binding"], "context", [false, "body"], true], ({ binding, context, body }, vm) => {
    if (!isIdentifier(binding) && binding !== null) {
        throw new JEBTypeError("expected variable name or null as first argument to \"with\"")
    }
    // Capture "from" here so that it doesn't capture the "with/teardown" opcode
    const dw = vm.newDynamicWind();
    // this looks backwards because it is - it's a stack, so the last one pushed (at the bottom)
    // is the first one executed
    pushCommand(vm, OP_with_teardown);
    pushCommand(vm, OP_block_invoke, body, false);
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
.throws jeb:type_error - if \`varname\` is null or \`handlers\` is not an object.
. Used to manage error handling, contextual resources, and continuation tracking.`);

const OP_with_setup = makeOpcode(<T extends JebVM>(vm: T, { 0: dw, 1: name }: [DynamicWind<T>, Identifier | null]) => {
    // we just got the before and after handlers evaluated
    const context = popData(vm) as Windable;
    const notObject = typeof context !== "object" || context === null;
    if (notObject || !("enter" in context || "exit" in context)) {
        throw new JEBTypeError(notObject ? "context manager should be an object" : "context manager should have 'enter' and/or 'exit' handlers");
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

const OP_with_boxprepare = makeOpcode((vm: JebVM, { 0: name }: [Identifier | null]) => pushData(vm, { _: name !== null ? { [name]: popData(vm) } : (popData(vm), {}) }), null);

const OP_with_install = makeOpcode(<T extends JebVM>(vm: T, { 0: dw }: [DynamicWind<T>]) => {
    vm.curDynamicWind = dw;
}, null);

const OP_with_teardown = makeOpcode(vm => {
    if (!vm.curDynamicWind.parent) throw new JEBError("dynamic wind stack underflow");
    const dw = vm.curDynamicWind;
    vm.curDynamicWind = dw.parent!;
    if (!dw.handler?.exit) return;
    // discard the exit handler's result
    pushCommand(vm, OP_shuffle, 1, []);
    pushCommand(vm, OP_apply, [false, null], undefined);
    pushData(vm, dw.handler.exit);
}, null);

// MARK: FFI
__initializer(vm => defineApplier(vm, ["function"], (vm, { 0: f }) => {
    pushCommand(vm, OP_ffi_invoke, f);
}, (_, f) => ({
    name: `[JS function ${f.name || "<no name>"}]`,
    signature: ALL_UNDERSCORE_NORMAL,
    macro: (f as any).MACRO ?? false,
}),
    `JEB's FFI can call Javascript functions. JEB does not check the \`.length\` of the function since it is wrong in some cases.
.throws jeb:ffi_error - if the FFI'ed function throws an error`));
const OP_ffi_invoke = makeOpcode((vm: JebVM, { 0: f }: [Function]) => {
    const args = popData(vm)._;
    vm.audit("jeb:ffi/call_function", f, args)
    pushData(vm, wrapThrowToError(JEBError, () => f(...args)));
}, null);

export const B_is_nil = makeJSFun("nil?", ["value"], ({ value }) => undefinedToNull(value) === null,
    `.func (nil? value)
..param {any} value
.returns {boolean}
. \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might still be falsy.`);

// MARK: fn/block applier
__initializer(vm => {
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
});
const OP_block_invoke = makeOpcode((vm: JebVM, { 0: b, 1: tail }: [Block, boolean | undefined]) => {
    if (!tail) pushCommand(vm, OP_set_env, vm.currentEnv);
    const env = vm.currentEnv = vm.createEnv(b.closureEnv);
    const injected = popData(vm)._, names = Reflect.ownKeys(injected);
    for (var i = names.length; i >= 0; i--) env.add(names[i]!, injected[names[i]!]);
    implicitBegin(vm, b.body);
}, null);
export const OP_set_env = makeOpcode((vm: JebVM, { 0: env }: [Env]) => vm.currentEnv = env, null);
const OP_fun_invoke = makeOpcode((vm: JebVM, { 0: fn, 1: tail }: [Fun<any>, boolean | undefined]) => {
    const argvObject = popData(vm);
    if (!fn.isImplicit) argvObject.return = vm.cc();
    pushCommand(vm, OP_block_invoke, fn.body, tail);
    pushData(vm, { _: argvObject });
}, null);

const B_fn = makeJSFun("fn", [[true, "params"], [true, "body"], true], ({ params, body }, vm) => {
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
    return new Fun(isImplicit, undefined, createSignature(params), new Block(vm.currentEnv, body), docstring);
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
.returns {Fun}
. Returns a new anonymous function with the specified parameters, documentation string, and body.`);

// MARK: continuation applier
__initializer(vm => defineApplier(vm, [Continuation], (vm, { 0: k }) => {
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
    "Reified GOTO which will jump back to the place it was captured from and return from there instead of returning from where it was called from like usual."));
const OP_continuation_invoke = makeOpcode(<T extends JebVM>(vm: T, { 0: k }: [Continuation<T>]) => k.invoke(vm, popData(vm).value), null);

// MARK: logic
export const OP_if = makeOpcode(<T extends JebVM>(vm: T, { 0: then, 1: else_, 2: isAsm }: [any, any, asm?: false | undefined] | [Command<T> | null, Command<T> | null, true]) => {
    const condition = popData(vm);
    if (isAsm) {
        if (condition) { if (then) pushCommand(vm, ...then); } else if (else_) pushCommand(vm, ...else_);
    } else {
        pushData(vm, condition ? then : else_);
        pushCommand(vm, OP_eval, undefined, true);
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
export const B_if = makeJSFun("if", ["condition", [true, "then"], [true, "else", null]], ({ condition, then, else: else_ }, vm) => {
    pushCommand(vm, OP_if, then, else_);
    return condition;
},
    `.macro (if cond then else)
..param {code} cond - condition; always evaluated
..param {code} then - case to be evaluated if \`cond\` is truthy
..param {code} [else=null] - case to be evaluated if \`cond\` is falsy
.returns {any}`);

export const B_begin = makeJSFun("begin", [[true, "body"], true], ({ body }, vm) => implicitBegin(vm, body!),
    `.macro (begin body...)
..param {code} body...
.returns {any | null} - null if \`body\` is empty, otherwise returns the result of the last body statement
. Runs each of the body statements in order.`);

export const B_let = makeJSFun("let", [[true, "__args"], true], (ao, vm, location) => {
    const args = ao.__args!;
    const extractParts = (bindings: any[]) => {
        bindings.forEach(b => {
            if (!isArray(b) || b.length !== 2) throw new JEBSyntaxError("invalid let binding");
        });
        return [bindings.map(b => b[0]), bindings.map(b => b[1])] as const;
    }
    // TODO: rewrite this transformation using Block ??
    if (isIdentifier(args[0])) {
        const loopname = args[0];
        const { 0: params, 1: initializers } = extractParts(args[1]);
        const body = args.slice(2);
        const recur = gensym("recur");
        const counter = gensym("counter");
        pushData(vm, [[B_fn, true, [recur],
            [B_set, [B_dollar, recur],
                [B_fn, true, [counter, ...params],
                    [B_audit, "jeb:loop_check", [B_dollar, counter]],
                    [B_let_in, loopname, [B_fn, true, params,
                        [recur, [B_plus, 1, [B_dollar, counter]], ...params.map(p => [B_dollar, p])]]],
                    ...body]],
            [recur, 0, ...initializers]], 0]);
    } else {
        const { 0: params, 1: initializers } = extractParts(args[0]);
        const body = args.slice(1);
        pushData(vm, [[B_fn, true, params, ...body], ...initializers]);
    }
    pushCommand(vm, OP_eval, location);
    return NOTHING;
},
    `.macro (let pairs body...)
.macro (let loopname pairs body...)
..param {string} loopname - variable name in which a reference to the entire \`let\` is put. \`let\` just expands to a [[fn]] expression, and the loopname variable allows \`body\` to recursively call that \`fn\`.
...receives {(...names: (typeof pairs)[number][1]) => any}
.param {[name: string, expression: code][]} pairs
.param {code} body...
. Each of the pairs' *expression*s will be evaluated in order in the parent environment and the result bound to *name* in the new environment; after all values are bound, the body is evaluated in the new environment.`);

export const B_let_in = makeJSFun("let-in", ["pairs", true], ({ pairs: args }, vm) => {
    const len = args.length
    if ((len & 1) > 0) {
        throw new JEBSyntaxError("let-in should have an even number of arguments");
    }
    var value;
    const newEnv = vm.createEnv(vm.currentEnv);
    for (var i = 0; i < len; i += 2) {
        const name = args[i];
        value = args[i + 1];
        if (!isIdentifier(name)) {
            throw new JEBSyntaxError("let-in name must be a valid identifier");
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

export const B_define = makeJSFun("define", [[true, "definition"], true], (ao, vm, location) => {
    const args = ao.definition!;
    const name = args[0] as Identifier | Identifier[];
    const setHelper = (name: Identifier, thing: any) => {
        pushData(vm, new VariableReference(AccessType.VARIABLE, vm.currentEnv, name));
        pushData(vm, thing);
    };
    if (isIdentifier(name)) {
        // variable definition: (define x 10)
        setHelper(name, args[1]);
    }
    else if (isArray(name)) {
        // function definition: (define (f x y) body) -> (define f (fn (x y) body))
        const funcName = name[0] as string;
        const params = name.slice(1) as string[];
        const body = args.slice(1);
        setHelper(funcName, [B_fn, params, ...body]);
    }
    else throw new JEBSyntaxError("invalid define syntax");
    pushCommand(vm, OP_set, true, true);
    pushCommand(vm, OP_shuffle, 2, [1, 0]);
    pushCommand(vm, OP_eval, location);
    return NOTHING;
},
    `.macro (define name value)
Defines a simple name=value.
..param {string} name
...receives {T}
..param {T} value
.macro (define (name params...) body...)
Expands into a [[fn]].
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
    const b = makeJSFun(operator, ["a", ["b", NOTHING]], ({ a, b }, vm) => {
        var f: () => Result<any, any>;
        if (b === NOTHING) {
            if (op1 === undefined) {
                throw new JEBTypeError(`${stringify(op2)} is not defined for one argument`);
            }
            f = () => vm.getProtocol(false, true, op1, [a]).run(vm, [a]);
        } else {
            f = () => vm.getProtocol(false, true, op2, [a, b]).run(vm, [a, b]);
        }
        return wrapThrowToError(JEBTypeError, f).else(e => { throw new JEBTypeError(String(e)); })
    },
        `.func (${operator} a [b])
..param {any} a
..param {any?} b
.throws jeb:type_error - if no overload was found for the given argument types
. ${doc}`);
    __initializer(vm => vm.addProtocol(op2, { type: [["number", "bigint"], ["number", "bigint"]], run: (_, { 0: a, 1: b }) => Ok(f2(a, b)), doc }));
    if (op1) {
        __initializer(vm => {
            vm.addProtocol(op1, { type: [["number"]], run: (_, { 0: a }) => Ok(num(a)), doc });
            vm.addProtocol(op1, { type: [["bigint"]], run: (_, { 0: a }) => Ok(big(a)), doc });
        });
    }
    return b;
}
export const B_plus = mathHelper("+", "add", "abs", numberOp(add), Math.abs, a => a > 0 ? a : -a, "Adds numbers or concatenates strings.");
__initializer(vm => vm.addProtocol("add", { type: [["string"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(a + b), doc: "Concatenates strings" }));
export const B_minus = mathHelper("-", "sub", "neg", numberOp((a, b) => a - b), a => -a, a => -a, "Subtracts numbers.\nIn the case of one number, returns the additive inverse (i.e. the negative).");
export const B_mul = mathHelper("*", "mul", undefined, numberOp((a, b) => a * b), id, id, "Multiplies numbers.\nThe special case of `string * number` or `number * string` results in repeating the string N times.");
const repeat = (a: string, b: number): Result<string, string> => {
    if (b < 0) return Err("Cannot repeat a negative number of times");
    if ((b | 0) !== b) return Err("Cannot repeat a non-integer number of times");
    return Ok(a.repeat(b));
}
__initializer(vm => {
    vm.addProtocol("mul", { type: [["string"], ["number"]], run: (_, { 0: a, 1: b }) => Ok(repeat(a, b)), doc: "Repeats strings" });
    vm.addProtocol("mul", { type: [["number"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(repeat(b, a)), doc: "Repeats strings" });
});
export const B_div = mathHelper("/", "div", "inv", (a, b) => float(a) / float(b), a => 1 / a, a => 1 / float(a), "Divides numbers.\nIn the case of one number, returns the multiplicative inverse (i.e. the reciprocal).");
export const B_mod = mathHelper("%", "mod", undefined, numberOp((a, b) => a % b), id, id, "Computes the modulo of two numbers.");
export const B_pow = mathHelper("pow", "pow", undefined, numberOp((a, b) => a ** b), id, id, "Computes the power of numbers.\nHowever, this function still folds from the right like the other math functions, so unlike how power is notated mathematically (where `a^b^c^d^e` means `a^(b^(c^(d^e)))`), `[\"pow\", a, b, c, d, e]` is interpreted as `(((a^b)^c)^d)^e`.");
export const B_bitAnd = mathHelper("bit-and", "bitAnd", undefined, numberOp((a, b) => a & b), id, id, "Computes the bitwise AND of all numbers.");
export const B_bitOr = mathHelper("bit-or", "bitOr", undefined, numberOp((a, b) => a | b), id, id, "Computes the bitwise OR of all numbers.");
export const B_bitXor = mathHelper("bit-xor", "bitXor", undefined, numberOp((a, b) => a ^ b), id, id, "Computes the bitwise XOR of all numbers.");
export const B_bitInv = makeJSFun("bit-inv", ["a"], ({ a }) => ~a, `.func (bit-inv number)
..param {number} a
. Computes the two's complement signed bitwise inverse of the number.`);

// comparisons
const comparisonHelper = (op: string, bits: Relation, doc: string) => {
    return makeJSFun(op, ["items", true], ({ items: a }, vm) => {
        const len = a.length;
        if (len < 2) return true;
        for (var i = 1; i < len; i++) {
            const arg = [a[i - 1], a[i], bits] as [any, any, Relation];
            const res = wrapThrowToError(JEBTypeError, () => vm.getProtocol(false, true, "cmp", arg).run(vm, arg));
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
export const B_eq = comparisonHelper("=", Relation.EQUAL, "True if all of the items are equal.");
export const B_not_eq = comparisonHelper("!=", Relation.NOT_EQ, "True if no adjacent pair of items are equal.");
export const B_less = comparisonHelper("<", Relation.LESS, compDocHelper("increasing"));
export const B_greater = comparisonHelper(">", Relation.GREATER, compDocHelper("decreasing"));
export const B_less_eq = comparisonHelper("<=", Relation.LESS_EQ, compDocHelper("nondecreasing"));
export const B_greater_eq = comparisonHelper(">=", Relation.GREATER_EQ, compDocHelper("nonincreasing"));

const compareFn = (_: JebVM, { 0: a, 1: b, 2: c }: [any, any, Relation]) => {
    if (a == b) return Ok(!!(c & Relation.EQUAL));
    if (a < b) return Ok(!!(c & Relation.LESS));
    if (a > b) return Ok(!!(c & Relation.GREATER));
    throw "unreachable";
};
__initializer(vm => {
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
});

// MARK: booleans
export const B_not = makeJSFun("not", ["value"], ({ value }) => !value, `.func (not value)
..param {any} value
.returns {boolean} - True if \`value\` is falsy (false, zero, undefined, null, or empty string), false otherwise.
. Boolean inverse.`);
const booleanHelper = (name: string, shortCircuitOn: boolean) => {
    return makeJSFun(name, ["a", [true, "b"]], ({ a, b }, vm, location) => {
        if ((!!a) === shortCircuitOn) return a;
        pushData(vm, b);
        pushCommand(vm, OP_eval, location, true);
        return NOTHING;
    },
        `.macro (fn a b)
..param {any} values...
. Boolean ${name.toUpperCase()} (short-circuits).
Evaluates \`a\`, if the result is ${shortCircuitOn ? "truthy" : "falsy"}, returns it, otherwise evaluates \`b\` and returns that.`);
}
export const B_and_shortcircuit = booleanHelper("and", false);
export const B_or_shortcircuit = booleanHelper("or", true);

// MARK: lists
export const B_list = makeJSFun("list", ["values", true], ({ values }) => values,
    `.func (list values...)
..param {T} values...
.returns {T[]}
. Returns the arguments in a list.`);
export const B_head = makeJSFun("head", ["list"], ({ list }) => list[0],
    `.func (head list)
..param {T[]} list
.returns {T} - The first element in the list`);
export const B_tail = makeJSFun("tail", ["list"], ({ list }) => list.slice(1),
    `.func (tail list)
..param {T[]} list
..returns {T[]} - A copy of the list without the first element`);
export const B_concat = makeJSFun("concat", ["lists", true], ({ lists }) => {
    const out: any[] = [];
    for (var arg of lists) {
        wrapThrowToError(JEBTypeError, () => out.push(...arg));
    }
    return out;
},
    `.func (concat lists...)
..param {T[]} lists...
If an argument is not a list, the value is coerced to a list using the Javascript \`...\` spread operator.
.returns {T[]}
. Concatenates the lists, and returns a new list.`)

// MARK: metaprogramming
export const B_quote = makeJSFun("quote", [[true, "expr"]], ({ expr }) => expr, `.macro (quote expr) | (' expr) | 'expr
..param {code} expr
.returns {code}
. Prevents its argument from being evaluated.`);

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
    if (form.length === 0) return [B_list];

    const { 0: head, 1: arg } = form;

    const same = (x: any, y: any) => {
        if (!isIdentifier(x)) return x === y;
        const v1 = env.get(x);
        return v1.ok && v1.data === y;
    }

    // ,x
    if (same(head, B_unquote)) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquote");
        return depth === 1 ? arg : [B_list, B_unquote, processQuasiquote(vm, arg, depth - 1)];
    }
    // ,@x
    if (same(head, B_unquoteSplicing)) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquoteSplicing");
        if (depth !== 1) return [B_list, B_unquoteSplicing, processQuasiquote(vm, arg, depth - 1)];
        throw new JEBSyntaxError("unquoteSplicing outside of list");
    }
    // nested `
    if (same(head, B_quasiquote)) {
        if (form.length !== 2) throw new JEBSyntaxError("expected 1 argument to quasiquote");
        return [B_list, B_quasiquote, processQuasiquote(vm, arg, depth + 1)];
    }

    // list – collect chunks, splice where needed
    const parts: any[] = [];
    const buffer: any[] = [];

    const flush = () => {
        if (buffer.length) {
            const part = [B_list];
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
        else if (same(el[0], B_unquoteSplicing)) {
            if (el.length !== 2) throw new JEBSyntaxError("expected 1 argument to unquoteSplicing");
            flush();
            parts.push(el[1]); // ,@x → will be spliced by concat
        } else {
            buffer.push(el);
        }
    }
    flush();

    if (parts.length === 0) return [B_list];
    if (parts.length === 1) return parts[0];
    // (concat part1 part2...)
    return [B_concat].concat(parts);
}

export const B_quasiquote = makeJSFun("quasiquote", [[true, "value"]], ({ value }, vm) => new MacroWrapper(processQuasiquote(vm, value, 1)),
    `.macro (quasiquote value) | (~ value) | ~value
..param {any} value
.returns {any}
. Prevents \`value\` from being evaluated, but walks the elements and replaces [[unquote]] and [[unquoteSplicing]] with the results of evaluating their arguments. The argument to [[unquoteSplicing]] must be a list.`);

export const B_unquote = makeJSFun("unquote", [[true, "value"]], (_, vm) => { throw new JEBSyntaxError("unquote" + " not valid outside of quasiquote", { return: vm.cc() }); },
    `.macro (unquote value) | (, value) | ,value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a value to be interpolated inside a [[quasiquote]].`);
export const B_unquoteSplicing = makeJSFun("unquoteSplicing", [[true, "value"]], (_, vm) => { throw new JEBSyntaxError("unquoteSplicing" + " not valid outside of quasiquote", { return: vm.cc() }); },
    `.macro (unquoteSplicing value) | (,@ value) | ,@value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a list to be interpolated via splicing inside a [[quasiquote]].`);

export const B_jsonparse = makeJSFun("jsonparse", ["json"], ({ json }) => wrapThrowToError(JEBValueError, () => parse(json)),
    `.func (jsonparse json)
..param {string} json
.throws jeb:value_error - if the string is not valid JSON
.returns {any}
. Parses the string using \`JSON.parse()\` and returns the object.`);
export const B_jsonstringify = makeJSFun("jsonstringify", ["value"], ({ value }) => wrapThrowToError(JEBValueError, () => stringify(value)),
    `.func (jsonstringify value)
..param {any} value
.throws jeb:value_error - if \`value\` contains something that can't be serialized, such as a function or circular reference
.returns {string}
. Stringifies the object to JSON using \`JSON.stringify()\`.`);

// TODO: split this all up
// MARK: loadBuiltins()
/**
 * Install the built-in functions and opcodes to the builtins scope of the given VM.
 *
 * Usually you don't need to do this, since the {@link JebVM} constructor calls this automatically,
 * but it might be needed if the VM state gets corrupted, or you mess with {@link JebVM#builtinsEnv} directly.
 */
export const loadBuiltins = (vm: JebVM) => {
    define(vm, "audit", B_audit);
    define(vm, "eval", B_eval);
    define(vm, "macro", B_macro_wrap);
    define(vm, "at", B_atLocation);
    define(vm, "splat", B_splat);
    define(vm, "kw", B_keyword);
    define(vm, "$", B_dollar);
    define(vm, ".", B_dot);
    define(vm, "set", B_set);
    define(vm, "throw", B_throw);
    define(vm, "err", B_err);
    define(vm, "with", B_with);
    define(vm, "nil?", B_is_nil);
    define(vm, "fn", B_fn);
    define(vm, "if", B_if);
    define(vm, "begin", B_begin);
    define(vm, "let", B_let);
    define(vm, "let-in", B_let_in);
    define(vm, "define", B_define);
    define(vm, "+", B_plus);
    define(vm, "-", B_minus);
    define(vm, "*", B_mul);
    define(vm, "/", B_div);
    define(vm, "%", B_mod);
    define(vm, "pow", B_pow);
    define(vm, "bit-and", B_bitAnd);
    define(vm, "bit-or", B_bitOr);
    define(vm, "bit-xor", B_bitXor);
    define(vm, "bit-inv", B_bitInv);
    define(vm, "=", B_eq);
    define(vm, "!=", B_not_eq);
    define(vm, "<", B_less);
    define(vm, ">", B_greater);
    define(vm, "<=", B_less_eq);
    define(vm, ">=", B_greater_eq);
    define(vm, "not", B_not);
    define(vm, "and", B_and_shortcircuit);
    define(vm, "or", B_or_shortcircuit);
    define(vm, "list", B_list);
    define(vm, "head", B_head);
    define(vm, "tail", B_tail);
    define(vm, "concat", B_concat);
    define(vm, "quote", B_quote);
    define(vm, "'", B_quote);
    define(vm, "quasiquote", B_quasiquote);
    define(vm, "~", B_quasiquote);
    define(vm, "unquote", B_unquote);
    define(vm, ",", B_unquote);
    define(vm, "unquoteSplicing", B_unquoteSplicing);
    define(vm, ",@", B_unquoteSplicing);
    define(vm, "jsonparse", B_jsonparse);
    define(vm, "jsonstringify", B_jsonstringify);
}
// MARK: end of loadBuiltins();


const underscorename = (lazy: Laziness): LonghandArgument<any, any> => ({
    name: "_",
    required: true,
    flags: [],
    defaultExpr: undefined,
    lazy
});

const ALL_UNDERSCORE_QUOTED: CallableSignature = {
    params: [],
    rest: underscorename(Laziness.QUOTED),
    kwRest: undefined,
};

const ALL_UNDERSCORE_NORMAL: CallableSignature = {
    params: [],
    rest: underscorename(Laziness.NONE),
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
//                 exit: ["fn", ["k", "type", "message", "ctx"],
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
//             enter: ["fn", ["k"],
//                 ["when", ["$", "k"],
//                     ["error", "jeb:state_error", "Continuation tried to jump into a 'with-baffle' block", {}]],
//                 null],
//             exit: ["fn", ["k", "_", true],
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
//                 [["fn", true, ["%"],
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
//             ["fn", ["acc", "cur"],
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

import { isArray } from "lib0/array";
import { undefinedToNull } from "lib0/conditions";
import { id, isNumber, isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { add } from "lib0/math";
import { keys } from "lib0/object";
import { Err, Ok, Result } from "ts-res";
import { BuiltinFunction, Lambda } from "../callable";
import { Continuation, DynamicWind, Windable } from "../continuation";
import { Accessor, AccessType, Applier, EnvVarLValue, Evaluator, findDispatcherForObject, LValue, ObjectLValue } from "../dispatch";
import { Env } from "../env";
import { resultToError, wrapThrowToError } from "../errors";
import { float, numberOp } from "../math";
import { Operation, theTypeName, typeOf } from "../overload";
import { JebVM } from "../vm";
import { alias, argsHelper, defineAccessor, defineApplier, defineBuiltin, defineEvaluator, defineOpcode, implicitBegin, NOTHING } from "./utils";

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
    defineOpcode(vm, "jeb:tb_pop", vm => vm.tracebackPop(),
        `.imm
.sed --
. Pops the top of the traceback stack, including all tailcall entries if there are some.`);
    defineOpcode(vm, "jeb:tb_push", (vm, args) => vm.tracebackPush(args[0], args[1]),
        `.imm function tailcall
..param {string} function
..param {boolean} [tailcall=false]
. Pushes the function to the traceback stack`);

    // MARK: op: stack shuffle
    defineOpcode(vm, "jeb:shuffle", (vm, args) => {
        const n = args[0] as number;
        const indices = args[1] as number[];
        const items = vm.popNData(n);
        for (var i = 0; i < indices.length; i++) {
            vm.pushData(items[indices[i]!]!);
        }
    }, `.imm count indices
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
    defineOpcode(vm, "jeb:eval", (vm, args) => {
        const code = vm.popData();
        const tailcallHint = args[0];
        const evaluator = findDispatcherForObject(vm.evalTable, code);
        if (!evaluator) {
            // just use the value directly
            vm.pushData(code);
            return;
        }
        evaluator.eval(code, tailcallHint, vm);
    },
        `.imm tailcall
.param {boolean?} [tailcall=false]
.sed value -- evaled
. Evaluates the top item of the stack. An array gets interpreted as a call and passed to [[jeb:apply]], an object has all its properties evaluated and reassembled, and anything else is treated as a literal and left as-is.`);
    defineBuiltin(vm, "eval", 1, false, false, (args, vm) => { vm.pushData(args[0]); vm.pushCommand("jeb:eval"); return NOTHING; },
        `.func (eval arg)
..param {any} arg
.returns {any}
. Evaluates \`arg\` in the current environment.`);

    defineEvaluator(vm, new class extends Evaluator<"object"> {
        constructor() { super("object"); }
        eval(code: any, _: boolean, vm: JebVM): void {
            if (code === null) {
                vm.pushData(null);
                return;
            }
            // evaluate all the properties
            const target = {};
            vm.pushData(target);
            for (var key of keys(code)) {
                vm.pushData(new ObjectLValue(target, key));
                vm.pushData(code[key]);
                vm.pushCommand("jeb:shuffle", 1, []);
                vm.pushCommand("jeb:set", AccessType.PROPERTY);
                vm.pushCommand("jeb:shuffle", 2, [1, 0]);
                vm.pushCommand("jeb:eval");
            }
        }
        doc = "Evaluates all of the property values, and then reassembles the object with the same set of keys with the evaluated values.";
    });
    defineEvaluator(vm, new class extends Evaluator<Array<any>> {
        constructor() { super(Array); }
        eval(code: any[], tailcallHint: boolean, vm: JebVM): void {
            if (code.length > 0) {
                vm.pushCommand("jeb:apply", code.slice(1), false, tailcallHint);
                vm.pushCommand("jeb:eval");
                vm.pushData(code[0]);
            } else {
                vm.pushCommand("jeb:throw", "jeb:value_error", "can't evaluate empty array", {
                    return: vm.cc(),
                });
            }
        }
        doc = `Calls the first item as a function.
.throws jeb:type_error - if the first item is not callable
.throws jeb:value_error - if the list is empty`
    });

    // MARK: apply
    defineOpcode(vm, "jeb:apply", (vm, args) => {
        const func = vm.popData();
        const values = args[0];
        const argc = values.length;
        const alreadyEvaluated = args[1];
        const tailcallHint = args[2];
        const applier = findDispatcherForObject(vm.applyTable, func);
        if (!applier) {
            vm.pushCommand("jeb:throw", "jeb:type_error", `can't call ${theTypeName(typeOf(func))}`, {
                return: vm.cc(),
            });
            return;
        }
        const name = applier.getNameOf(func);
        if (name) {
            if (!tailcallHint) vm.pushCommand("jeb:tb_pop");
        }
        if (applier.getIsMacro(func)) vm.pushCommand("jeb:eval");
        // check arg counts
        const arity = applier.getArity(func);
        var ok = true;
        if (isNumber(arity)) {
            ok = argc === arity;
        } else if (arity !== null) {
            ok = argc >= arity.min && argc <= arity.max;
        }
        if (!ok) {
            vm.pushCommand("jeb:throw", "jeb:value_error", `expected ${isNumber(arity) ? arity : `${arity!.min} to ${arity!.max}`} args, got ${argc}`, {});
            return;
        }
        applier.apply(func, alreadyEvaluated, tailcallHint, values, vm);
    },
        `.imm expressions alreadyEvaluated tailcall
..param {code[]} expressions
..param {false} alreadyEvaluated
..param {boolean?} [tailcall=false]
.imm values alreadyEvaluated tailcall
..param {any[]} values
..param {true} alreadyEvaluated
..param {boolean?} [tailcall=false]
.sed functor -- result
.throws jeb:type_error - when the object is not callable
.throws jeb:value_error - when the argument count is wrong
. Pops the top value from the stack and calls it with the provided arguments.
If \`alreadyEvaluated\` is false, the arguments are interpreted as unevaluated expressions and the applier for the function or macro can choose to evaluate or not evaluate them.
If \`alreadyEvaluated\` is true, they are interpreted as values and the applier should not evaluate them, even if it isn't a macro.`);
    // MARK: string applier
    defineApplier(vm, new class extends Applier<"string"> {
        constructor() { super("string"); }
        apply(func: string, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            // String is a special case because normally strings evaluate to themselves
            // (not to a callable function), but if it's in head position, we implicitly look it up.
            vm.pushCommand("jeb:apply", args, alreadyEvaluated, tailcallHint);
            vm.pushCommand("jeb:get", AccessType.FUNCTION);
            vm.pushData(new EnvVarLValue(vm.currentEnv, func));
        }
        getNameOf = () => undefined;
        getArity = () => null;
        getIsMacro = () => false;
        doc = `Applying a string is shorthand for looking up the variable with the same name as the string and calling that instead.
As a consequence, \`('foo)\` is the same as \`(foo)\` in JEB even though the former would be invalid in conventional Lisp.`;
    });
    // MARK: builtin applier
    defineApplier(vm, new class extends Applier<BuiltinFunction> {
        constructor() { super(BuiltinFunction); }
        apply(func: BuiltinFunction, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            vm.pushCommand("jeb:exec/builtin", func, args.length);
            vm.pushCommand("jeb:tb_push", this.getNameOf(func), tailcallHint);
            argsHelper(vm, args, !func.isSpecial && !alreadyEvaluated);
        }
        getNameOf = (func: BuiltinFunction) => func.name;
        getArity = (func: BuiltinFunction) => func.arity;
        getIsMacro = (func: BuiltinFunction) => func.resultIsMacro;
        doc = "Wrapper for a Javascript function that gives it a few properties to make it easier for JEB to call it.";
    });
    defineOpcode(vm, "jeb:exec/builtin", (vm, args) => {
        const func = args[0] as BuiltinFunction;
        const argc = args[1] as number;
        const argv = vm.popNData(argc).reverse();
        const result = func.impl(argv, vm);
        if (result !== NOTHING) {
            vm.pushData(result);
        }
    }, null);

    // MARK: variables
    defineAccessor(vm, new class extends Accessor<"object"> {
        constructor() { super("object"); }
        access(object: any, field: PropertyKey) { return new ObjectLValue(object, field); }
        doc = "Default object property accessor.";
    });

    defineAccessor(vm, new class extends Accessor<Env> {
        constructor() { super(Env); }
        access(env: Env, field: PropertyKey) { return new EnvVarLValue(env, field as string); }
        doc = "Accessor for variables from an environment.";
    });
    defineOpcode(vm, "jeb:index/access", vm => {
        const name = vm.popData() as PropertyKey;
        const obj = vm.popData();
        const accessor = findDispatcherForObject(vm.accessTable, obj);
        if (!accessor) {
            vm.pushCommand("jeb:throw", "jeb:type_error", `${stringify(theTypeName(typeOf(obj)))} is not subscriptable`, {});
            return;
        }
        vm.pushData(accessor.access(obj, name));
    }, null);
    defineOpcode(vm, "jeb:index", (vm, args) => {
        const name = args[0] as any;
        vm.pushCommand("jeb:index/access");
        vm.pushCommand("jeb:eval");
        vm.pushData(name);
    },
        `.sed obj name -- lvalue
.throws jeb:type_error - if the object can't be indexed
. Finds an Accessor for the object and pushes the LValue for the given field.`);
    defineOpcode(vm, "jeb:get", (vm, args) => {
        const lvalue = vm.popData() as LValue;
        const accessType = args[0] as AccessType;
        const shouldBind = args[1] as boolean;
        lvalue.get(vm, accessType, shouldBind);
    },
        `.imm accessType shouldBind
.param {AccessType} accessType
.param {boolean?} [shouldBind=false]
.sed lvalue -- value
. Takes an LValue on the top of the stack and unwraps it by calling its get() method.`);
    defineOpcode(vm, "jeb:set", (vm, args) => {
        const lvalue = vm.popData() as LValue;
        const accessType = args[0] as AccessType;
        const create = args[1] as boolean;
        const readonly = args[2] as boolean;
        lvalue.set(vm, vm.peekData(), accessType, create, readonly);
    },
        `.imm accessType create readonly
.param {AccessType} accessType
.param {boolean?} [create=false]
.param {boolean?} [readonly=false]
.sed value lvalue -- value
. Takes an LValue on the top of the stack and calls the \`set()\` method with the next item in the stack as the value to set.`);
    const pushNamePath = (vm: JebVM, path: string | any[], last: (type: AccessType) => void) => {
        if (!isArray(path)) path = [path];
        var item = vm.currentEnv as any, shouldEval = false;
        if (!isString(path[0]) && path.length > 0) {
            if (path.length < 2) {
                vm.pushCommand("jeb:throw", "jeb:syntax_error", "complex expression indexing must have an index", {});
                return;
            }
            item = path[0];
            path = path.slice(1);
            shouldEval = true;
        }
        for (var i = path.length - 1, first = true; i >= 0; i--, first = false) {
            const type = i > 0 ? AccessType.PROPERTY : AccessType.VARIABLE;
            if (first) {
                last(type);
            } else {
                vm.pushCommand("jeb:get", type);
            }
            vm.pushCommand("jeb:index", path[i]);
        }
        vm.pushData(item);
        if (shouldEval) {
            vm.pushCommand("jeb:eval");
        }
    };
    defineBuiltin(vm, "$", 1, true, false, (args, vm) => {
        const name = args[0] as string | any[];
        pushNamePath(vm, name, type => vm.pushCommand("jeb:get", type, true));
        return NOTHING;
    }, `.macro ($ (name properties...))
The \`properties\` index the variable like Javascript square brackets.
..param {string} name - can be an expression; it is evaluated
..param {string} properties...
.func ($ name)
..param {string} name
.throws jeb:reference_error - if the name is not defined anywhere
.returns {any}
. Look up the variable with this name in the current environment.`);
    defineOpcode(vm, "jeb:set/old", (vm, args) => {
        const type = args[0] as AccessType;
        const valueExpr = args[1];
        const old = args[2] as boolean;
        const lambda = new Lambda(false, true, "", ["_"], [], null, [valueExpr], vm.currentEnv, "");
        // accessor is first on stack
        vm.pushCommand("jeb:apply/resetEnv", vm.currentEnv);
        if (old) vm.pushCommand("jeb:shuffle", 1, []);
        vm.pushCommand("jeb:set", type);
        vm.pushCommand("jeb:shuffle", 2, [1, 0]);
        vm.pushCommand("jeb:exec/lambda", lambda, 1);
        if (old) vm.pushCommand("jeb:shuffle", 2, [1, 0, 1]);
        vm.pushCommand("jeb:get", type, true);
        vm.pushCommand("jeb:shuffle", 1, [0, 0]);
    }, null);
    defineBuiltin(vm, "set", { min: 2, max: 3 }, true, false, (args, vm) => {
        const name = args[0] as string | any[];
        const valueExpr = args[1] as any;
        const old = args[2] as boolean;
        pushNamePath(vm, name, type => vm.pushCommand("jeb:set/old", type, valueExpr, old));
        return NOTHING;
    }, `.macro (set name value old)
..param {string} name
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
.macro (set (name properties...) value old)
The properties will be used to index the object, and the last one will be used to set the property.
..param {string} name
..param {string} properties...
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
..throws jeb:value_error - if the array of names is malformed
.throws jeb:reference_error - if the value is not defined anywhere
.returns {old ? U : T}
. Set the value of the variable in the environment in which it is defined, and returns the new or value as determined by \`old\`.`);

    // MARK: error handling
    defineOpcode(vm, "jeb:throw", (vm, args) => {
        const type = args[0] as string;
        const message = args[1] as string;
        const restarts = args[2] as Record<string, any>;
        if (vm.curDynamicWind.parent) {
            // call exit handler with error details
            // if it returns true, it means the error was handled and we can continue execution
            const dw = vm.curDynamicWind;
            vm.curDynamicWind = dw.parent!;
            dw.restore(vm);
            if (dw.handler?.exit) {
                vm.pushCommand("jeb:if", null, ["jeb:throw", type, message, restarts], true);
                vm.pushCommand("jeb:apply", [false, type, message, restarts], true);
                vm.pushData(dw.handler?.exit);
            } else {
                vm.pushCommand("jeb:throw", type, message, restarts);
            }
            return;
        }
        // if there's nothing to catch the error, just throw it back to JavaScript
        vm.fatalError(type, message);
    },
        `.imm type message context
.param {string} type
.param {string} message
.param {object} context
.sed -- (does not return)
. Triggers an error with the specified type, error, and context.`);
    defineBuiltin(vm, "error", 3, false, false, (args, vm) => {
        const type = args[0] as string;
        const error = args[1] as string;
        const ctx = args[2] as object;
        vm.pushCommand("jeb:throw", type, error, ctx);
        return NOTHING;
    }, `.func (error type message context)
..param {string} type
..param {string} message
..param {object} context
.returns {never}
. Throw an error with the specified type, message, and context value. If we're inside a [[with]] block, it will trigger the \`exit\` handler of the context object to possibly handle the error. If the error is not handled, it will be thrown as a Javascript error, causing the program to halt.
\`type\` is recommended to be a namespaced string, such as \`foo:bar\`, to prevent collisions.`);
    // MARK: with
    defineBuiltin(vm, "with", { min: 2, max: Infinity }, true, false, (args, vm) => {
        const binding = args[0];
        if (!isString(binding) && binding !== null) {
            vm.pushCommand("jeb:throw", "jeb:type_error", "expected variable name or null as first argument to \"with\"", {});
            return;
        }
        const context = args[1];
        const body = args.slice(2);
        // Capture "from" here so that it doesn't capture the "with/teardown" opcode
        const dw = vm.newDynamicWind();
        // this looks backwards because it is - it's a stack, so the last one pushed (at the bottom)
        // is the first one executed
        vm.pushCommand("jeb:with/teardown");
        implicitBegin(vm, body);
        vm.pushCommand("jeb:with/setup", dw, binding);
        vm.pushCommand("jeb:eval");
        vm.pushData(context);
        return NOTHING;
    }, `.macro (with varname context body...)
..param {string | null} varname
...receives {T} - Return value of the \`enter\` handler (if present)
..param {object} handlers
...prop {(continuation: boolean) => T} [enter=null]
When entering the block, the \`enter\` hook will be called with \`true\` or \`false\` to indicate if the entry is due to a continuation or not. The first time the block is entered, the return value of the \`enter\` hook will be bound to the \`varname\`.
...prop {(continuation: boolean, type: string | null, message: string | null, context: object | null) => boolean} exit
When exiting the block, the \`exit\` hook will be called. \`continuation\` is as with the \`enter\` handler (indicating if the block exit is due to a continuation or not), and \`type\`, \`message\`, and \`context\` will be \`null\` if there is no error being handled, or non-\`null\` if there is an error in progess. The \`exit\` handler can return \`true\` to indicate that it has handled the error, and prevent it from propagating up the call stack.
Some errors also include a *restart* as part of their \`context\` - this will be a continuation that when invoked, will jump back to the expression that caused the error and resume execution with the substituted value.
..param {code} body...
.throws jeb:type_error - if \`varname\` is null or \`handlers\` is not an object.
. Used to manage error handling, contextual resources, and continuation tracking.`);

    defineOpcode(vm, "jeb:with/setup", (vm, args) => {
        // we just got the before and after handlers evaluated
        const context = vm.popData() as Windable;
        const notObject = typeof context !== "object" || context === null;
        if (notObject || !("enter" in context || "exit" in context)) {
            vm.pushCommand("jeb:throw", "jeb:type_error", notObject ? "context manager should be an object" : "context manager should have 'enter' and/or 'exit' handlers", {});
            return;
        }
        const name = args[1] as string | null;
        const dw = (args[0] as DynamicWind).setHandler(context);
        // set up the winder to be installed AFTER the enter handler runs, so that errors thrown by this handler won't be caught by the exit handler
        vm.pushCommand("jeb:with/install", dw);

        if (!context.enter) return;
        vm.pushCommand("jeb:shuffle", 1, []);
        if (name !== null) {
            vm.pushCommand("jeb:set", AccessType.VARIABLE, true);
            vm.pushCommand("jeb:shuffle", 2, [1, 0]);
            vm.pushData(new EnvVarLValue(vm.currentEnv, name));
        }
        vm.pushCommand("jeb:apply", [false], true);
        vm.pushData(context.enter);
    }, null);

    defineOpcode(vm, "jeb:with/install", (vm, args) => {
        vm.curDynamicWind = args[0] as DynamicWind;
    }, null);

    defineOpcode(vm, "jeb:with/teardown", vm => {
        if (!vm.curDynamicWind.parent) throw new Error("Dynamic wind stack underflow");
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        if (!dw.handler?.exit) return;
        // discard the exit handler's result
        vm.pushCommand("jeb:shuffle", 1, []);
        vm.pushCommand("jeb:apply", [false, null, null, null], true);
        vm.pushData(dw.handler.exit);
    }, null);

    // MARK: FFI
    defineApplier(vm, new class extends Applier<"function"> {
        constructor() { super("function"); }
        apply(f: Function, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            vm.pushCommand("jeb:exec/callFFI", f, args.length);
            vm.pushCommand("jeb:tb_push", this.getNameOf(f), tailcallHint);
            argsHelper(vm, args, !alreadyEvaluated);
        }
        getNameOf = (f: Function) => `[function ${f.name}]`;
        getArity = () => null;
        getIsMacro = (f: any) => !!f.MACRO;
        doc = `JEB's FFI can call Javascript functions. JEB does not check the \`.length\` of the function since it is wrong in some cases.
.throws jeb:ffi_error - if the FFI'ed function throws an error`
    });

    defineOpcode(vm, "jeb:exec/callFFI", (vm, args) => {
        const f = args[0] as Function;
        const argc = args[1] as number;
        const argv = vm.popNData(argc).reverse();
        const result = wrapThrowToError(vm, "jeb:ffi_error", () => f.apply(null, argv));
        if (result !== NOTHING) vm.pushData(result);
    }, null);

    defineBuiltin(vm, "nil?", 1, false, false, args => undefinedToNull(args[0]) === null,
        `.func (nil? value)
..param {any} value
.returns {boolean}
. \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might still be falsy.`);

    // MARK: lambda applier
    defineApplier(vm, new class extends Applier<Lambda> {
        constructor() { super(Lambda); }
        apply(lambda: Lambda, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            if (!tailcallHint || lambda.isMacro) vm.pushCommand("jeb:apply/resetEnv", vm.currentEnv);
            vm.pushCommand("jeb:exec/lambda", lambda, args.length);
            if (!lambda.isImplicit) vm.pushCommand("jeb:tb_push", this.getNameOf(lambda), tailcallHint);
            argsHelper(vm, args, !lambda.isMacro && !alreadyEvaluated);
        }
        getNameOf = (lambda: Lambda) => lambda.isImplicit ? undefined : lambda.name ?? (lambda.isMacro ? "[macro]" : "[lambda]");
        getArity(lambda: Lambda) {
            const required = lambda.args.length;
            const optional = lambda.optArgs.length;
            const rest = !!lambda.restArg;
            return required > 0 && optional === 0 && !rest ? required : {
                min: required,
                max: rest ? Infinity : required + optional,
            };
        }
        getIsMacro = (lambda: Lambda) => lambda.isMacro;
        doc = "\"Compiled\" wrapper for a function or macro defined entirely out of JEB code (which is just JSON)."
    });
    defineOpcode(vm, "jeb:apply/resetEnv", (vm, args) => {
        vm.currentEnv = args[0] as Env;
    }, null);
    defineOpcode(vm, "jeb:exec/lambda", (vm, args) => {
        const lambda = args[0] as Lambda;
        const argc = args[1] as number;
        const required = lambda.args, nRequired = required.length;
        const optional = lambda.optArgs, nOpt = optional.length;
        const rest = lambda.restArg;
        if ((nRequired + nOpt) > argc) {
            // Need to evaluate defaults.
            const dynamicEnv = vm.createEnv(lambda.closureEnv, vm.currentEnv);
            vm.pushCommand("jeb:exec/lambda", lambda, nRequired + nOpt);
            argsHelper(vm, optional.slice(argc - nRequired).map(o => o[1]), true);
            vm.currentEnv = dynamicEnv;
            return NOTHING;
        }
        const callEnv = vm.createEnv(lambda.closureEnv);
        const argv = vm.popNData(argc).reverse();
        for (var n = 0; n < nRequired; n++) {
            callEnv.add(required[n]!, argv[n]);
        }
        for (var n = 0; n < nOpt; n++) {
            callEnv.add(optional[n]![0], argv[nRequired + n]);
        }
        if (rest) {
            callEnv.add(rest, argv.slice(nRequired + nOpt));
        }
        if (!lambda.isImplicit) callEnv.add("return", vm.cc());
        vm.currentEnv = callEnv;
        return implicitBegin(vm, lambda.body);
    }, null);
    const lambdaHelper = (name: string, isMacro: boolean, kind: string, extra: string) => {
        defineBuiltin(vm, name, { min: 2, max: Infinity }, true, false, (args, vm) => {
            var isImplicit = false;
            if (typeof args[0] === "boolean") {
                isImplicit = args[0];
                args = args.slice(1);
            }
            const params = args[0] as (string | [string, any] | true)[];
            const body = args.slice(1);
            const docstring = isString(body[0]) && body.length > 1 ? body.shift() : "";
            const required: string[] = [], optional: [string, any][] = [];
            var rest: string | null = null;
            for (var i = 0; i < params.length; i++) {
                const p = params[i];
                if (isString(p)) {
                    if (i + 2 === params.length && params[i + 1] === true) {
                        rest = p;
                        break;
                    }
                    if (optional.length > 0) {
                        vm.pushCommand("jeb:throw", "jeb:syntax_error", "required parameter cannot follow optional parameter", {});
                        return NOTHING;
                    }
                    required.push(p);
                } else if (isArray(p)) {
                    if (p.length !== 2) {
                        vm.pushCommand("jeb:throw", "jeb:syntax_error", "invalid optional argument");
                        return;
                    }
                    optional.push(p);
                } else {
                    vm.pushCommand("jeb:throw", "jeb:syntax_error", "invalid parameter to lambda", {})
                }
            }
            return new Lambda(isMacro, isImplicit, undefined, required, optional, rest, body, vm.currentEnv, docstring);
        },
            `.macro (${name} (parameters...) body...) | (${name} (parameters... #t) body...) | (${name} #t (parameters...) docstring body...)
The form with \`#t\` right after the \`${kind}\` defines it as an implicit ${kind}, where the special \`return\` continuation is not injected and the call will not show up in the traceback of an error (it would normally show as \`[${kind}]\` unless assigned to a name).
..param {string | [string, code]} parameters - list of parameter names
If the param is a 2-tuple \`[*name*, *default*]\`, then the parameter is optional, and if it is not provided in a call, then the value of \`default\` is evaluated in a dynamic environment of both the environment in which the ${name} was defined, as well as the environment from which it was called.
The form with \`#t\` at the end of the parameters list defines the last parameter name to be a rest parameter that will be an array at runtime filled with all the arguments given after it. It cannot have a default since defining it as a rest parameter implicitly defines the default as \`[]\`.
..param {string} docstring - Defines the documentation string for this ${kind}. The first element of the body will only be interpreted as a docstring if there is at least one statement after it (rendering the string otherwise pointless).
..param {code} body... - Statements to be executed in sequence (as with [[begin]]) to calculate the return value of the ${name}.
...injected {Continuation} return - if the first element after the \`${name}\` is not \`#t\`, a continuation jumping back to where the ${kind} was called from is injected into the \`return\` variable.
.returns {Lambda}
. Returns a new anonymous ${kind} with the specified parameters, documentation string, and body.${extra}`);
    }
    lambdaHelper("lambda", false, "function", "");
    lambdaHelper("macro", true, "macro", "\nA macro differs from a normal function in that its arguments are passed in *before* being evaluated, so the macro body has access to the actual code passed in; additionally, the return value of the macro is expected to be code as well, and is evaluated again the the scope that the macro was called from.");

    // MARK: continuation applier
    defineApplier(vm, new class extends Applier<Continuation> {
        constructor() { super(Continuation); }
        apply(cont: Continuation, alreadyEvaluated: boolean, _: boolean, args: any[], vm: JebVM) {
            vm.pushCommand("jeb:exec/cont", cont);
            if (!alreadyEvaluated) {
                vm.pushCommand("jeb:eval");
            }
            vm.pushData(args[0]);
        }
        getNameOf = () => undefined;
        getArity = () => 1;
        getIsMacro = () => false;
        doc = "Reified GOTO which will jump back to the place it was captured from and return from there instead of returning from where it was called from like usual."
    });
    defineOpcode(vm, "jeb:exec/cont", (vm, args) => {
        const cont = args[0] as Continuation;
        cont.invoke(vm, vm.popData());
    }, null);

    // MARK: logic
    defineOpcode(vm, "jeb:if", (vm, args) => {
        const condition = vm.popData();
        const then = args[0];
        const else_ = args[1];
        const isAsm = args[2];
        if (isAsm) {
            // @ts-ignore
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
    defineBuiltin(vm, "if", { min: 2, max: 3 }, true, false, (args, vm) => {
        const condition = args[0];
        const then = args[1];
        const else_ = args[2] ?? null;
        vm.pushCommand("jeb:if", then, else_);
        vm.pushCommand("jeb:eval");
        vm.pushData(condition);
        return NOTHING;
    }, `.macro (if cond then else)
..param {code} cond - condition; always evaluated
..param {code} then - case to be evaluated if \`cond\` is truthy
..param {code} [else=null] - case to be evaluated if \`cond\` is falsy
.returns {any}`);

    defineBuiltin(vm, "begin", null, true, false, (args, vm) => implicitBegin(vm, args),
        `.macro (begin body...)
..param {code} body...
.returns {any | null} - null if \`body\` is empty, otherwise returns the result of the last body statement
. Runs each of the body statements in order.`);

    defineBuiltin(vm, "let", null, true, false, (args, vm) => {
        if (isString(args[0])) {
            // rewrite (let loop ((x 1) (y 2)) body) to ((lambda (loop) (set! loop (lambda (x y) body)) (loop 1 2)) null)
            const loopname = args[0];
            const bindings = args[1] as [string, any][];
            const body = args.slice(2);
            const params = bindings.map(b => b[0]);
            const initializers = bindings.map(b => b[1]);
            vm.pushData([["lambda", true, [loopname], ["set", loopname, ["lambda", true, params, ...body]], [loopname, ...initializers]], null]);
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

    defineBuiltin(vm, "let-in", { min: 2, max: Infinity }, false, false, (args, vm) => {
        const newEnv = vm.createEnv(vm.currentEnv);
        if ((args.length & 1) > 0) {
            vm.pushCommand("jeb:throw", "jeb:syntax_error", "let-in should have an even number of arguments", {});
            return NOTHING;
        }
        var value;
        for (var i = 0; i < args.length; i += 2) {
            const name = args[i];
            value = args[i + 1];
            if (!isString(name)) {
                vm.pushCommand("jeb:throw", "jeb:syntax_error", "let-in name must be a string", {});
                return NOTHING;
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

    defineBuiltin(vm, "define", null, true, false, (args, vm) => {
        const name = args[0] as string | string[];
        const setHelper = (name: string, thing: any) => {
            vm.pushCommand("jeb:set", AccessType.VARIABLE, true, true);
            vm.pushCommand("jeb:shuffle", 2, [1, 0]);
            vm.pushCommand("jeb:eval");
            vm.pushData(new EnvVarLValue(vm.currentEnv, name));
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
        else {
            vm.pushCommand("jeb:throw", "jeb:syntax_error", "invalid define syntax", {});
        }
        return NOTHING;
    }, `.macro (define name value)
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
    const mathHelper = (operator: string, operation: Operation, identity: number,
        numnum: (x: number, y: number) => any,
        bignum: (x: bigint, y: number) => any,
        numbig: (x: number, y: bigint) => any,
        bigbig: (x: bigint, y: bigint) => any,
        num: (x: number) => any,
        big: (x: bigint) => any,
        doc: string,
    ) => {
        defineBuiltin(vm, operator, null, false, false, (a, vm) => {
            if (a.length === 0) return identity;
            if (a.length === 1) return resultToError(vm, "jeb:type_error", vm.math.call(operation, a[0]!));
            var acc = a[0]!;
            for (var i = 1; i < a.length; i++) {
                const res = vm.math.call(operation, acc, a[i]);
                if (!res.ok) {
                    vm.pushCommand("jeb:throw", "jeb:type_error", "math error: " + res.error, {
                        return: vm.cc(),
                    });
                    return NOTHING;
                }
                acc = res.data;
            }
            return acc;
        }, `.func (${operator} values...)
..param {any} values...
.throws jeb:type_error - if no overload was found for the given argument types
. ${doc}`);
        vm.math.overload(operation, [["number"], ["number"]], (a, b) => Ok(numnum(a, b)));
        vm.math.overload(operation, [["bigint"], ["bigint"]], (a, b) => Ok(bigbig(a, b)));
        vm.math.overload(operation, [["bigint"], ["number"]], (a, b) => Ok(bignum(a, b)));
        vm.math.overload(operation, [["number"], ["bigint"]], (a, b) => Ok(numbig(a, b)));
        vm.math.overload(operation, [["number"]], a => Ok(num(a)));
        vm.math.overload(operation, [["bigint"]], a => Ok(big(a)));
    }
    const addNumbers = numberOp(add);
    mathHelper("+", "add", 0, addNumbers, addNumbers, addNumbers, addNumbers, id, id, "Adds numbers or concatenates strings.");
    vm.math.overload("add", [["string"], ["string"]], (a, b) => Ok(a + b));
    const subtractNumbers = numberOp((a, b) => a - b);
    mathHelper("-", "sub", 0, subtractNumbers, subtractNumbers, subtractNumbers, subtractNumbers, a => -a, a => -a, "Subtracts numbers.\nIn the case of one number, returns the additive inverse (i.e. the negative).");
    const multiplyNumbers = numberOp((a, b) => a * b);
    mathHelper("*", "mul", 1, multiplyNumbers, multiplyNumbers, multiplyNumbers, multiplyNumbers, id, id, "Multiplies numbers.\nThe special case of `string * number` or `number * string` results in repeating the string N times");
    const repeat = (a: string, b: number): Result<string, string> => {
        if (b < 0) return Err("Cannot repeat a negative number of times");
        if ((b | 0) !== b) return Err("Cannot repeat a non-integer number of times");
        return Ok(a.repeat(b));
    };
    vm.math.overload("mul", [["string"], ["number"]], (a, b) => repeat(a, b));
    vm.math.overload("mul", [["number"], ["string"]], (a, b) => repeat(b, a));
    const divideNumbers = (a: number | bigint, b: number | bigint) => float(a) / float(b);
    mathHelper("/", "div", NaN, divideNumbers, divideNumbers, divideNumbers, divideNumbers, a => 1 / a, a => 1 / float(a), "Divides numbers.\nIn the case of one number, returns the multiplicative inverse (i.e. the reciprocal).");
    const moduloNumbers = numberOp((a, b) => a % b);
    mathHelper("%", "mod", NaN, moduloNumbers, moduloNumbers, moduloNumbers, moduloNumbers, _ => NaN, _ => NaN, "Computes the modulo of two numbers.");
    const powNumbers = numberOp((a, b) => a ** b);
    mathHelper("pow", "pow", NaN, powNumbers, powNumbers, powNumbers, powNumbers, _ => NaN, _ => NaN, "Computes the power of numbers.\nHowever, this function still folds from the right like the other math functions, so unlike how power is notated mathematically (where `a^b^c^d^e` means `a^(b^(c^(d^e)))`), `[\"pow\", a, b, c, d, e]` is interpreted as `(((a^b)^c)^d)^e`.");
    const bitAndNumbers = numberOp((a, b) => a & b);
    mathHelper("bit-and", "bitAnd", -1, bitAndNumbers, bitAndNumbers, bitAndNumbers, bitAndNumbers, id, id, "Computes the bitwise AND of all numbers.");
    const bitOrNumbers = numberOp((a, b) => a | b);
    mathHelper("bit-or", "bitOr", 0, bitOrNumbers, bitOrNumbers, bitOrNumbers, bitOrNumbers, id, id, "Computes the bitwise OR of all numbers.");
    const bitXorNumbers = numberOp((a, b) => a ^ b);
    mathHelper("bit-xor", "bitXor", 0, bitXorNumbers, bitXorNumbers, bitXorNumbers, bitXorNumbers, id, id, "Computes the bitwise XOR of all numbers.");
    defineBuiltin(vm, "bit-inv", 1, false, false, a => ~a[0], `.func (bit-inv number)
..param {number} number
. Computes the two's complement signed bitwise inverse of the number.`);

    // comparisons
    const comparisonHelper = (op: string, bits: number, doc: string) => {
        defineBuiltin(vm, op, null, false, false, (a, vm) => {
            if (a.length < 2) return true;
            for (var i = 1; i < a.length; i++) {
                const res = vm.math.call("cmp", a[i - 1], a[i], bits);
                if (!res.ok) {
                    vm.pushCommand("jeb:throw", "jeb:type_error", "comparison error: " + res.error, {
                        return: vm.cc(),
                    });
                    return NOTHING;
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
        ["=", 4, "True if all of the items are equal."],
        ["!=", 3, "True if no adjacent pair of items are equal."],
        ["<", 2, compDocHelper("increasing")],
        [">", 1, compDocHelper("decreasing")],
        ["<=", 6, compDocHelper("nondecreasing")],
        [">=", 5, compDocHelper("nonincreasing")],
    ] as [string, number, string][])) {
        comparisonHelper(name, bits, doc);
    }
    const compareFn = (a: any, b: any, c: number) => {
        if (a == b) return Ok(!!(c & 4));
        if (a < b) return Ok(!!(c & 2));
        if (a > b) return Ok(!!(c & 1));
        throw "unreachable";
    };
    vm.math.overload("cmp", [["number", "bigint"], ["number", "bigint"], ["number"]], compareFn);
    vm.math.overload("cmp", [["string"], ["string"], ["number"]], compareFn);
    vm.math.overload("cmp", [[null], [null], ["number"]], (a, b, c) => {
        if (a === b) return Ok(!!(c & 4));
        if ((!!(c & 2)) !== (!!(c & 1))) return Err(`No ordering defined for ${stringify(theTypeName(typeOf(a)))} and ${stringify(theTypeName(typeOf(b)))}`);
        return Ok(!!(c & 1));
    });

    // MARK: booleans
    defineBuiltin(vm, "not", 1, false, false, args => !args[0], `.func (not value)
..param {any} value
.returns {boolean} - True if \`value\` is falsy (false, zero, undefined, null, or empty string), false otherwise.
. Boolean inverse.`);
    const booleanHelper = (name: string, shortCircuitOn: boolean) => {
        defineBuiltin(vm, name, null, true, true, (args: any[], vm: JebVM) => {
            if (args.length === 0) {
                return !shortCircuitOn;
            }
            const sym = vm.currentEnv.gensym();
            const rest = [name, ...args.slice(1)];
            const getsym = ["$", sym];
            vm.pushData([["lambda", true, [sym],
                shortCircuitOn ?
                    ["if", getsym, getsym, rest] :
                    ["if", getsym, rest, getsym]
            ], args[0]]);
            vm.pushCommand("jeb:eval", true);
            return NOTHING;
        }, `.func (${name} values...)
..param {any} values...
. Boolean ${name.toUpperCase()} (short-circuits)`);
    }
    booleanHelper("and", false);
    booleanHelper("or", true);

    // MARK: lists
    defineBuiltin(vm, "list", null, false, false, a => a, `.func (list values...)
..param {T} values...
.returns {T[]}
. Returns the arguments in a list.`);
    defineBuiltin(vm, "head", 1, false, false, a => a[0][0], `.func (head list)
..param {T[]} list
.returns {T} - The first element in the list`);
    defineBuiltin(vm, "tail", 1, false, false, a => a[0].slice(1), `.func (tail list)
..param {T[]} list
..returns {T[]} - A copy of the list without the first element`);
    defineBuiltin(vm, "concat", null, false, false, args => {
        const out: any[] = [];
        for (var arg of args) {
            try {
                out.push(...arg);
            } catch (e) {
                vm.pushCommand("jeb:throw", "jeb:type_error", String(e), {});
                return NOTHING;
            }
        }
        return out;
    }, `.func (concat lists...)
..param {T[]} lists...
If an argument is not a list, the value is coerced to a list using the Javascript \`...\` spread operator.
.returns {T[]}
. Concatenates the lists, and returns a new list.`)

    // MARK: metaprogramming
    defineBuiltin(vm, "quote", 1, true, false, a => a[0], `.macro (quote expr) | (' expr) | 'expr
..param {code} expr
.returns {code}
. Prevents its argument from being evaluated.`);
    alias(vm, "quote", "'");
    defineBuiltin(vm, "quasiquote", 1, true, true, (args, vm) =>
        processQuasiquote(vm, args[0], 1).else(error => {
            vm.pushCommand("jeb:throw", "jeb:value_error", error, {
                return: vm.cc(),
            });
            return NOTHING;
        }),
        `.macro (quasiquote value) | (~ value) | ~value
..param {any} value
.returns {any}
. Prevents \`value\` from being evaluated, but walks the elements and replaces [[unquote]] and [[unquoteSplicing]] with the results of evaluating their arguments. The argument to [[unquoteSplicing]] must be a list.`);
    alias(vm, "quasiquote", "~");

    defineBuiltin(vm, "unquote", 1, false, false, (_, vm) => (vm.pushCommand("jeb:throw", "jeb:syntax_error", "unquote" + " not valid outside of quasiquote", {
        return: vm.cc(),
    }), NOTHING), `.macro (unquote value) | (, value) | ,value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a value to be interpolated inside a [[quasiquote]].`);
    defineBuiltin(vm, "unquoteSplicing", 1, false, false, (_, vm) => (vm.pushCommand("jeb:throw", "jeb:syntax_error", "unquoteSplicing" + " not valid outside of quasiquote", {
        return: vm.cc(),
    }), NOTHING), `.macro (unquoteSplicing value) | (,@ value) | ,@value
.returns {never}
.throws jeb:syntax_error - when called as a normal function outside of a [[quasiquote]].
. Marks a list to be interpolated via splicing inside a [[quasiquote]].`);
    alias(vm, "unquote", ",");
    alias(vm, "unquoteSplicing", ",@");

    defineBuiltin(vm, "parseJSON", 1, false, false, (args, vm) => wrapThrowToError(vm, "jeb:value_error", () => parse(args[0])),
        `.func (parseJSON json)
..param {string} json
.throws jeb:value_error - if the string is not valid JSON
.returns {any}
. Parses the string using \`JSON.parse()\` and returns the object.`);
    defineBuiltin(vm, "dumpJSON", 1, false, false, (args, vm) => wrapThrowToError(vm, "jeb:value_error", () => stringify(args[0])),
        `.func (dumpJSON value)
..param {any} value
.throws jeb:value_error - if \`value\` contains something that can't be serialized, such as a function or circular reference
.returns {string}
. Stringifies the object to JSON using \`JSON.stringify()\`.`);

    vm.currentEnv = vm.builtinsEnv;
    vm.start(STANDARD_LIBRARY);
    while (vm.step());
    if (vm.paused) throw new Error("Invalid state while setting up stdlib");
    vm.reset();
}
// MARK: end of loadBuiltins();



// MARK: processQuasiquote
const processQuasiquote = (vm: JebVM, form: any, depth: number): Result<any, string> => {
    const env = vm.currentEnv;
    // atoms
    if (!isArray(form)) {
        if (typeof form !== "object" || form === null) {
            return Ok(form);
        } else {
            const newObj: Record<string, any> = {};
            for (var [key, value] of Object.entries(form)) {
                const processedValue = processQuasiquote(vm, value, depth);
                if (!processedValue.ok) return processedValue;
                newObj[key] = processedValue.data;
            }
            return Ok(newObj);
        }
    }
    if (form.length === 0) return Ok(["quote", []]);

    const head = form[0], tail = form.slice(1);

    const same = (x: any, y: string) => {
        if (!isString(x)) return false;
        const v1 = env.get(x);
        const v2 = env.get(y);
        return v1.ok ? (v2.ok && v1.data === v2.data) : !v2.ok;
    }

    // ,x
    if (same(head, "unquote")) {
        if (form.length !== 2) return Err("expected argument to " + "unquote");
        return Ok(depth === 1 ? tail[0] : ["list", "unquote", processQuasiquote(vm, tail[0], depth - 1)]);
    }
    // ,@x
    if (same(head, "unquoteSplicing")) {
        if (depth !== 1) return Ok(["list", "unquoteSplicing", processQuasiquote(vm, tail[0], depth - 1)]);
        return Err("unquoteSplicing" + " outside of list");
    }
    // nested `
    if (same(head, "quasiquote")) {
        if (form.length !== 2) return Err("expected argument to " + "quasiquote");
        return Ok(["list", "quasiquote", processQuasiquote(vm, tail[0], depth + 1)]);
    }

    // list – collect chunks, splice where needed
    const parts: any[] = [];
    const buffer: any[] = [];

    var flushFail: Result<any, string> | undefined;
    const flush = () => {
        if (buffer.length) {
            const part = ["list"];
            for (var e of buffer) {
                const x = processQuasiquote(vm, e, depth);
                if (!x.ok) {
                    flushFail = x;
                    return;
                }
                part.push(x.data);
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
            if (el.length !== 2) return Err("expected argument to " + "unquoteSplicing");
            flush();
            if (flushFail) return flushFail;
            parts.push(el[1]); // ,@x → will be spliced by concat
        } else {
            buffer.push(el);
        }
    }
    flush();
    if (flushFail) return flushFail;

    if (parts.length === 0) return Ok(["quote", []]);
    if (parts.length === 1) return Ok(parts[0]);
    // (concat part1 part2...)
    return Ok(["concat"].concat(parts));
}

// MARK: JSON based standard library!
const STANDARD_LIBRARY = ["begin",
    ["define", true, ["comment", "items", true],
        `.macro (comment items...) | (#; items...) | #;(items...)
..param {any} items
.returns {null}
. Skips evaluating the items and returns null immediately.`,
        null],
    ["define", "#;", ["$", "comment"]],
    ["define", true, ["uncomment", "items", true],
        `.macro (uncomment items...) | (!; items...) | !;(items...)
..param {code} items
. Evaluates the items as with [[begin]].`,
        ["quasiquote", ["begin", ["unquoteSplicing", ["$", "items"]]]]],
    ["define", "!;", ["$", "uncomment"]],
    ["define", ["call-with-current-continuation", "f"],
        `.func (call-with-current-continuation f) | (call/cc f)
..param {(k: Continuation) => any} f
.returns {any} - possibly multiple times if the continuation is invoked later
. Calls the function with a *continuation*, which is a special callable object. When the continuation is called with one argument, it will not return normally, and instead jump back to the place where \`call/cc\` was created from and make the \`call/cc\` return the given value instead - *even if* the \`call/cc\` expression has already returned!
Invoking a continuation will cause the \`enter\` and \`exit\` handlers of [[with]] blocks jumped across to be triggered with \`true\` to indicate it was due to a continuation.
Continuations can be used for very complex control structures and can be incredibly confusing to debug, so use with care.`,
        ["f", ["$", "return"]]],
    ["define", "call/cc", ["$", "call-with-current-continuation"]],
    ["define", true, ["when", "test", "body", true],
        `.macro (when test body...)
..param {boolean} test
..param {code => T} body
.returns {T | null}
. If \`condition\` is truthy, runs \`body\` as with [[begin]].
(Equivalent to \`([[if]] condition ([[begin]] body...))\`.)`,
        ["quasiquote",
            ["if", ["unquote", ["$", "test"]],
                ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
    ["define", true, ["unless", "test", "body", true],
        `.macro (unless test body...)
..param {boolean} test
..param {code => T} body
.returns {T | null}
. If \`condition\` is falsy, runs \`body\` as with [[begin]].
(Equivalent to \`([[when]] ([[not]] condition) body...)\`.)`,
        ["quasiquote",
            ["if", ["unquote", ["$", "test"]],
                null,
                ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
    ["define", true, ["try", "body", "handlers"],
        `.macro (try body handlers)
..param {code} body - single statement that forms the body. If you need more than one statement, use [[begin]].
..param {object} handlers
...prop {(message: string, context: object) => ignored} (name) - called for the error with \`type\` equal to \`name\` (where \`name\` is the property name of the object).
...prop {(type: string, message: string, context: object) => ignored} * - called if an error is thrown, but no specific handler matched it
...prop {() => ignored} else - called if no error is thrown
. Catches and handles errors.
During evaluation of the body, if an error is thrown, the error's \`type\` (as returned by [[with]]) will be checked to see if it's in the handlers, and if it is, the handler is called with the \`message\` and \`context\` of the error.
If no handler directly matches, the special catch-all handler \`"\\*"\` is tried.
In both cases if the handler exists, \`true\` is returned to [[with]] to stop propagation of the error. If the handler wants to propagate the error, it should re-throw it using [[error]].`,
        ["quasiquote", ["let", [["handlers", ["unquote", ["$", "handlers"]]]],
            ["with", null, {
                exit: ["lambda", ["k", "type", "message", "ctx"],
                    ["let",
                        [
                            ["handler", ["$", ["handlers", ["$", "type"]]]],
                            ["starHandler", ["$", ["handlers", "*"]]],
                            ["elseHandler", ["$", ["handlers", "else"]]]
                        ],
                        ["unless", ["$", "type"],
                            ["when", ["$", "elseHandler"], ["elseHandler"]],
                            ["return", true]],
                        ["when", ["$", "handler"],
                            ["handler", ["$", "message"], ["$", "ctx"]],
                            ["return", true]],
                        ["when", ["$", "starHandler"],
                            ["starHandler", ["$", "type"], ["$", "message"], ["$", "ctx"]],
                            ["return", true]],
                        false]],
            },
                ["unquote", ["$", "body"]]]]]],
    ["define", true, ["with-baffle", "body", true],
        `.macro (with-baffle body...)
..param {code} body... - evaluated as with [[begin]]
.throws jeb:state_error - if a continuation tries to jump in or out.
. Prevents continuations from jumping in or out of \`body\`; only normal control flow or exceptions can be used to enter or exit.`,
        ["quasiquote", ["with", null, {
            enter: ["lambda", ["k"],
                ["when", ["$", "k"],
                    ["error", "jeb:state_error", "Continuation tried to jump into a 'with-baffle' block", {}]],
                null],
            exit: ["lambda", ["k", "_", true],
                ["when", ["$", "k"],
                    ["error", "jeb:state_error", "Continuation tried to jump out of a 'with-baffle' block", {}]],
                false]
        },
            ["unquoteSplicing", ["$", "body"]]]]],
    ["define", ["length", "x"], `.func (length value)
..param {any[] | string} value
.returns {number} - the length of \`value\``,
        ["$", ["x", "length"]]],
    ["define", ["zero?", "x"], `.func (zero? value)
..param {number} value
.returns {boolean} - true if \`value\` is zero`,
        ["=", ["$", "x"], 0]],
    ["define", true, ["|>", "value", "items", true],
        `.macro (|> value expressions...)
..param {any} value
..param {code} expressions...
...injected {any} %
. Pipes the \`value\` as the variable \`%\` into the next expression, and then the result of it becomes the next \`%\`, etc. until all expressions have been evaluated.
This is analogous to Javascript's proposed pipe operator, specifically the Hack style.`,
        ["if", ["zero?", ["length", ["$", "items"]]],
            ["$", "value"],
            ["quasiquote",
                [["lambda", true, ["%"],
                    ["|>", ["unquoteSplicing", ["$", "items"]]]],
                ["unquote", ["$", "value"]]]]]],
    ["define", ["reduce", "list", "f", "value"],
        `.func (reduce list function value)
..param {T[]} list
..param {(value: R, item: T) => R} function
..param {R} value
.returns {R}
. Repeatedly call the function with 2 arguments; the first one is the current \`value\` and the second is each element of \`list\` in turn. The return value will be the new \`value\` for the next element.
When the list is empty, returns the accumulated value.`,
        ["if", ["zero?", ["length", ["$", "list"]]],
            ["$", "value"],
            ["reduce",
                ["tail", ["$", "list"]],
                ["$", "f"],
                ["f", ["$", "value"], ["head", ["$", "list"]]]]]],
    ["define", ["map", "list_", "f"],
        `.func (map list function)
..param {T[]} list
..param {(x: T) => R} function
.returns {R[]}
. Return a new list with the result of applying the function to each element of the list in order.`,
        ["reduce",
            ["$", "list_"],
            ["lambda", ["acc", "cur"],
                ["concat", ["$", "acc"], ["list", ["f", ["$", "cur"]]]]],
            ["list"]]],
    ["define", true, ["while", "cond", "body", true],
        `.macro (while cond body...)
..param {code => boolean} cond
..param {code} body
. Evaluates \`cond\` repeatedly, followed by \`body\`, until \`cond\` evaluates to a falsy value and then returns null.`,
        ["quasiquote", ["when",
            ["unquote", ["$", "cond"]],
            ["unquoteSplicing", ["$", "body"]],
            ["while", ["unquote", ["$", "cond"]], ["unquoteSplicing", ["$", "body"]]]]]],
];
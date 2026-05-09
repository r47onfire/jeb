import { isArray, last } from "lib0/array";
import { undefinedToNull } from "lib0/conditions.js";
import { id, isNumber, isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { keys } from "lib0/object";
import { BuiltinFunction, Lambda } from "./callable";
import { Continuation, DynamicWind, Windable } from "./continuation";
import { Env } from "./env";
import { jsError, resultToError, tracebackPop, tracebackPush } from "./errors";
import { float, numberOp } from "./math";
import { add, Operation, typeMatches } from "./overload";
import { err, ok, Result } from "./result";
import { Applier, JebVM, OpcodeFunction } from "./vm";

export function defineBuiltin(vm: JebVM, name: string, arity: { min: number, max: number } | number | null, isSpecial: boolean, resultIsMacro: boolean, fn: (args: any[], vm: JebVM) => any, doc: string) {
    vm.globalEnv.define(name, new BuiltinFunction(name, arity, isSpecial, resultIsMacro, fn, doc));
}

export function defineOpcode(vm: JebVM, name: string, fn: OpcodeFunction) {
    vm.opcodeTable[name] = fn;
}

export function defineApplier(vm: JebVM, apply: Applier<any>) {
    vm.applyTable.push(apply);
}

export function alias(vm: JebVM, name1: string, name2: string) {
    vm.globalEnv.define(name2, vm.globalEnv.get(name1).value!);
}

function argsHelper(vm: JebVM, args: any[], shouldEval: boolean) {
    const len = args.length;
    for (var i = len - 1; i >= 0; i--) {
        vm.pushData(args[i]);
        if (shouldEval) {
            // rotate the argument we just evaluated around and bring up the next one
            // optimize if len == 1 then don't bother shuffling!
            if (len > 1) vm.pushCommand("shuffle", len, new Array(len).fill(0).map((_, j) => (j + 1) % len));
            vm.pushCommand("eval");
        }
    }
}

export function implicitBegin(vm: JebVM, args: any) {
    const len = args.length;
    if (len === 0) {
        vm.pushData(null);
    }
    // Evaluate all in order (reverse because stack)
    for (var i = len - 1, last = true; i >= 0; i--, last = false) {
        // Drop all but the last one
        if (!last) vm.pushCommand("shuffle", 1, []);
        vm.pushData(args[i]);
        // Do a tail call on the last item
        vm.pushCommand("eval", last);
    }
}

export const NOTHING = Symbol("nothing");

// TODO: split this all up
// MARK: loadBuiltins()
export function loadBuiltins(vm: JebVM) {


    // MARK: op: traceback push/pop
    defineOpcode(vm, "return", tracebackPop);
    defineOpcode(vm, "call", tracebackPush);

    // MARK: op: stack shuffle
    // N/[0, 1, 2, 3, ..., N-1] = identity, 2/[1, 0] = swap, 1/[] = drop, 1/[0, 0] = dup, N/[1, 2, 3, 4, ..., N-1, 0] = N-tuck, etc.
    defineOpcode(vm, "shuffle", (vm, args) => {
        const n = args[0] as number;
        const indices = args[1] as number[];
        const items = vm.popNData(n);
        for (var i = 0; i < indices.length; i++) {
            vm.pushData(items[indices[i]!]!);
        }
    });

    // MARK: eval
    defineOpcode(vm, "eval", (vm, args) => {
        const code = vm.popData();
        const tailcallHint = args[0] || false;
        if (isArray(code)) {
            vm.pushCommand("apply", code.slice(1), false, tailcallHint);
            vm.pushCommand("eval");
            vm.pushData(code[0]);
        } else {
            // just use the value directly
            vm.pushData(code);
        }
    });
    defineBuiltin(vm, "eval", 1, false, false, (args, vm) => {
        vm.pushCommand("eval");
        vm.pushData(args[0]);
        return NOTHING;
    }, `["eval", <argument>]

Evaluate the argument in the current environment and return the result.`);

    // MARK: apply
    defineOpcode(vm, "apply", (vm, args) => {
        const func = vm.popData();
        const values = args[0];
        const argc = values.length;
        const alreadyEvaluated = args[1] || false;
        const tailcallHint = args[2] || false;
        const applier = vm.applyTable.find(a => typeMatches(func, a.type));
        if (!applier) {
            const typename = func === null ? "null" : isArray(func) ? "array" : typeof func;
            vm.pushCommand("throw", "type_error", `can't call ${typename === "object" ? (func.constructor.name ?? "object") : typename}`, {
                return: Continuation.fromVM(vm),
            });
            return;
        }
        if (applier.getIsMacro(func)) vm.pushCommand("eval");
        const name = applier.getNameOf(func);
        if (name) {
            if (!tailcallHint) vm.pushCommand("return");
        }
        // check arg counts
        const arity = applier.getArity(func);
        var ok = true;
        if (isNumber(arity)) {
            ok = argc === arity;
        } else if (arity !== null) {
            ok = argc >= arity.min && argc <= arity.max;
        }
        if (!ok) {
            vm.pushCommand("throw", "value_error", `expected ${isNumber(arity) ? arity : `${arity!.min} to ${arity!.max}`} args, got ${argc}`, {});
            return;
        }
        applier.apply(func, alreadyEvaluated, tailcallHint, values, vm);
    });
    // MARK: string applier
    defineApplier(vm, new class extends Applier<"string"> {
        constructor() { super("string"); }
        apply(func: string, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            // String is a special case because normally strings evaluate to themselves
            // (not to a callable function), but if it's in head position, we implicitly look it up.
            vm.pushCommand("apply", args, alreadyEvaluated, tailcallHint);
            vm.pushCommand("lookup", true);
            vm.pushData(func);
        }
        getNameOf() { return undefined; }
        getArity() { return null; }
        getIsMacro() { return false; };
    });
    // MARK: builtin applier
    defineApplier(vm, new class extends Applier<BuiltinFunction> {
        constructor() { super(BuiltinFunction); }
        apply(func: BuiltinFunction, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            vm.pushCommand("exec.builtin", func, args.length);
            vm.pushCommand("call", this.getNameOf(func), tailcallHint);
            argsHelper(vm, args, !func.isSpecial && !alreadyEvaluated);
        }
        getNameOf(func: BuiltinFunction) { return func.name; }
        getArity(func: BuiltinFunction) { return func.arity; }
        getIsMacro(func: BuiltinFunction) { return func.resultIsMacro; }
    });
    defineOpcode(vm, "exec.builtin", (vm, args) => {
        const func = args[0] as BuiltinFunction;
        const argc = args[1] as number;
        const argv = vm.popNData(argc).reverse();
        const result = func.impl(argv, vm);
        if (result !== NOTHING) {
            vm.pushData(result);
        }
    });

    // MARK: variables
    defineOpcode(vm, "lookup", (vm, args) => {
        const name = vm.popData();
        const variable = vm.getVar(name);
        const functionHint = args[0] ?? false;
        if (!variable.ok) {
            vm.pushCommand("throw", "reference_error", `${functionHint ? "function" : "variable"} ${stringify(name)} not found`, {
                define: Continuation.fromVM(vm, ["store", name])
            });
            return;
        }
        vm.pushData(variable.value);
    });
    defineOpcode(vm, "get_prop", (vm, args) => {
        const name = vm.popData();
        const obj = vm.popData();
        if (undefinedToNull(obj) === null) {
            const propHint = args[0] as string ?? "unknown expression";
            vm.pushCommand("throw", "type_error", `can't get property ${stringify(name)} of ${obj} (evaluating ${propHint})`, {});
            return;
        }
        vm.pushData(obj[name]);
    });
    defineBuiltin(vm, "$", 1, true, false, (args, vm) => {
        const name = args[0] as string | any[];
        if (!isArray(name)) {
            vm.pushData(name);
        } else {
            if (name.length < 2) {
                vm.pushCommand("throw", "value_error", "array form of $ must have 2 or more elements", {});
                return;
            }
            // On each iteration, the stack looks like:
            //     value nameA nameB nameC
            // So we swap, eval nameA, then index it and it becomes
            //     value nameB nameC
            // rinse and repeat.
            for (var i = name.length - 1; i > 0; i--) {
                vm.pushData(name[i]);
                vm.pushCommand("get_prop", name.slice(0, i + 1).map((j, i) => i > 0 ? j : stringify([j])).join(""));
                vm.pushCommand("eval");
                vm.pushCommand("shuffle", 2, [1, 0]);
            }
            vm.pushData(name[0]);
        }
        vm.pushCommand("lookup");
        vm.pushCommand("eval");
        return NOTHING;
    }, `["$", <name>]
["$", [<name>, <properties...:sameline>]]

Look up the variable with this name in the current environment, and return the value, or throw a \`reference_error\` if it is not defined anywhere.
If \`properties\` are given, they index the variable like Javascript square brackets.`);
    defineOpcode(vm, "store", (vm, args) => {
        const value = vm.peekData();
        const name: string = args[0];
        const didSet = vm.setVar(name, value);
        if (!didSet) {
            vm.pushCommand("throw", "reference_error", `variable ${stringify(name)} not found`, {
                define: Continuation.fromVM(vm, ["store", name])
            });
            return;
        }
        if (value instanceof Lambda && value.name === undefined) value.name = name;
    });
    defineOpcode(vm, "define", (vm, args) => {
        const value = vm.peekData();
        const name: string = args[0];
        vm.currentEnv.define(name, value);
        if (value instanceof Lambda && value.name === undefined) value.name = name;
    });
    defineOpcode(vm, "set_prop", (vm, args) => {
        const name = vm.popData();
        const obj = vm.popData();
        if (undefinedToNull(obj) === null) {
            const propHint = args[0] as string ?? "unknown expression";
            vm.pushCommand("throw", "type_error", `can't set property ${stringify(name)} on ${obj} (evaluating ${propHint})`, {});
            return;
        }
        try {
            obj[name] = vm.peekData();
        } catch (e) {
            vm.pushCommand("throw", "type_error", String(e), {});
        }
    });
    defineBuiltin(vm, "set", 2, true, false, (args, vm) => {
        const name = args[0] as string | any[];
        if (!isArray(name)) {
            vm.pushCommand("store", name);
            vm.pushCommand("eval");
            vm.pushData(args[1]);
        } else {
            if (name.length < 2) {
                vm.pushCommand("throw", "value_error", "array form of set must have 2 or more elements", {});
                return;
            }
            // On the last iteration, stack looks like:
            //     obj name value
            // so we rot value to the top:
            //     value obj name
            // eval value, then rot name to the top and swap obj and value:
            //     name obj value
            // eval name, and then set.
            vm.pushData(args[1]);
            vm.pushCommand("set_prop", name.map((j, i) => i > 0 ? j : stringify([j])).join(""));
            vm.pushCommand("eval");
            vm.pushCommand("shuffle", 3, [2, 1, 0]);
            vm.pushCommand("eval");
            vm.pushCommand("shuffle", 3, [1, 2, 0]);
            vm.pushData(last(name));
            // On each prior iteration, it's the same as in $
            for (var i = name.length - 2; i > 0; i--) {
                vm.pushData(name[i]);
                vm.pushCommand("get_prop", name.slice(0, i + 1).map((j, i) => i > 0 ? j : stringify([j])).join(""));
                vm.pushCommand("eval");
                vm.pushCommand("shuffle", 2, [1, 0]);
            }
            vm.pushCommand(isString(name[0]) ? "lookup" : "eval");
            vm.pushData(name[0]);
        }
        return NOTHING;
    }, `["set", <name>, <value>]
["set", [<name>, <properties...:sameline>], <value>]
["set", [<object>, <properties...:sameline>], <value>]

Set the value of the variable in the environment in which it is defined. If it wasn't defined anywhere, throw a \`reference_error\`.
If \`properties\` are given, the \`name\` will be looked up instead, and the properties will be used to index the object, and the last one will be used to set the property.`);

    // MARK: error handling
    defineOpcode(vm, "throw", (vm, args) => {
        const type = args[0] as string;
        const error = args[1] as string;
        const ctx = args[2] as Record<string, any>;
        if (vm.curDynamicWind.parent) {
            // call exit handler with error details
            // if it returns true, it means the error was handled and we can continue execution
            const dw = vm.curDynamicWind;
            vm.curDynamicWind = dw.parent!;
            dw.restore(vm);
            if (dw.handler?.exit) {
                vm.pushCommand("if", null, ["throw", type, error, ctx], true);
                vm.pushCommand("apply", [false, type, error, ctx], true);
                vm.pushData(dw.handler?.exit);
            } else {
                vm.pushCommand("throw", type, error, ctx);
            }
            return;
        }
        // if there's nothing to catch the error, just throw it back to JavaScript
        jsError(type, error, vm.tracebackArray());
    });
    defineBuiltin(vm, "error", 3, false, false, (args, vm) => {
        const type = args[0] as string;
        const error = args[1] as string;
        const ctx = args[2] as Record<string, Continuation>;
        vm.pushCommand("throw", type, error, ctx);
        return NOTHING;
    }, `["error", <type>, <message>, <context>]

Throw an error with the specified type, message, and context value. If we're inside a \`with\` block, it will trigger the \`exit\` handler of the context object to possibly handle the error. If the error is not handled, it will be thrown as a Javascript error, causing the program to halt.`);
    // MARK: with
    defineBuiltin(vm, "with", { min: 2, max: Infinity }, true, false, (args, vm) => {
        const binding = args[0];
        if (typeof binding === "object" && binding !== null) {
            vm.pushCommand("throw", "type_error", "expected variable name as first argument to 'with'", {});
            return;
        }
        const context = args[1];
        const body = args.slice(2);
        // Capture "from" here so that it doesn't capture the "with.teardown" opcode
        const dw = DynamicWind.fromVM(vm);
        // this looks backwards because it is - it's a stack, so the last one pushed (at the bottom)
        // is the first one executed
        vm.pushCommand("with.teardown");
        implicitBegin(vm, body);
        vm.pushCommand("with.setup", dw, binding);
        vm.pushCommand("eval");
        vm.pushData(context);
        return NOTHING;
    }, `["with", <varname>, <context>, <body...>]

Used to manage error handling, contextual resources, and continuation tracking. The \`context\` should be an object with \`enter\` and/or \`exit\` properties, which are callable functions.
When entering the block, the \`enter\` hook will be called with one parameter, \`true\` or \`false\` to indicate if the entry is due to a continuation or not. The first time the block is entered, the return value of the \`enter\` hook will be bound to the \`varname\`.
When exiting the block, the \`exit\` hook will be called with four parameters - \`continuation\`, \`type\`, \`message\`, and \`context\`. \`continuation\` is as with the \`enter\` handler (indicating if the block exit is due to a continuation or not), and \`type\`, \`message\`, and \`context\` will be \`null\` if there is no error being handled, or non-\`null\` if there is an error in progess. The \`exit\` handler can return \`true\` to indicate that it has handled the error, and prevent it from propagating up the call stack.
Some errors also include a *restart* as part of their \`context\` - this will be a continuation that when invoked, will jump back to the site of the error and resume execution with the substituted value.`);

    defineOpcode(vm, "with.setup", (vm, args) => {
        // we just got the before and after handlers evaluated
        const context = vm.popData() as Windable;
        const notObject = typeof context !== "object" || context === null;
        if (notObject || !("enter" in context || "exit" in context)) {
            vm.pushCommand("throw", "type_error", notObject ? "context manager should be an object" : "context manager should have 'enter' and/or 'exit' handlers", {});
            return;
        }
        const name = args[1] as string | null;
        const dw = (args[0] as DynamicWind).setHandler(context);
        // set up the winder to be installed AFTER the enter handler runs, so that errors thrown by this handler won't be caught by the exit handler
        vm.pushCommand("with.install", dw);

        if (!context.enter) return;
        vm.pushCommand("shuffle", 1, []);
        if (name !== null) vm.pushCommand("store", name);
        vm.pushCommand("apply", [false], true);
        vm.pushData(context.enter);
    });

    defineOpcode(vm, "with.install", (vm, args) => {
        vm.curDynamicWind = args[0] as DynamicWind;
    });

    defineOpcode(vm, "with.teardown", vm => {
        if (!vm.curDynamicWind.parent) throw new Error("Dynamic wind stack underflow");
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        // discard the exit handler's result
        vm.pushCommand("shuffle", 1, []);
        vm.pushCommand("apply", [false, null, null, null], true);
        vm.pushData(dw.handler?.exit);
    });

    // MARK: JS objects
    defineBuiltin(vm, "obj", 1, false, false, (args, vm) => {
        const quoted = args[0] as Record<string, any>;
        // evaluate all the properties
        const target = {};
        vm.pushData(target);
        for (var key of keys(quoted)) {
            vm.pushData(key);
            vm.pushData(target);
            vm.pushData(quoted[key]);
            vm.pushCommand("shuffle", 1, []);
            vm.pushCommand("set_prop", "", true);
            vm.pushCommand("shuffle", 3, [2, 1, 0]);
            vm.pushCommand("eval");
        }
        return NOTHING;
    }, `["obj", <object:sameline>]

Evaluates all the properties of the object, and returns a new object with the results of evaluation. The properties are evaluated in an unspecified order, but it's usually the order in which they were defined or added to the object.`);

    defineBuiltin(vm, "nil?", 1, false, false, args => undefinedToNull(args[0]) === null, `["nil?", <value>]

Returns \`true\` if the object is Javascript \`undefined\` or \`null\`. Any other value (including \`false\`, \`""\`, or \`[]\`) is considered not-null, even though it might be falsy.`);

    // MARK: lambda applier
    defineApplier(vm, new class extends Applier<Lambda> {
        constructor() { super(Lambda); }
        apply(lambda: Lambda, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM) {
            if (!tailcallHint || lambda.isMacro) vm.pushCommand("env.reset", vm.currentEnv);
            vm.pushCommand("exec.lambda", lambda, args.length);
            vm.pushCommand("call", this.getNameOf(lambda), tailcallHint);
            argsHelper(vm, args, !lambda.isMacro && !alreadyEvaluated);
        }
        getNameOf(lambda: Lambda) { return lambda.name ?? "[lambda]"; }
        getArity(lambda: Lambda) {
            const required = lambda.args.length;
            const optional = lambda.optArgs.length;
            const rest = !!lambda.restArg;
            return required > 0 && optional === 0 && !rest ? required : {
                min: required,
                max: rest ? Infinity : required + optional,
            };
        }
        getIsMacro(lambda: Lambda) { return lambda.isMacro; }
    });
    defineOpcode(vm, "env.reset", (vm, args) => {
        vm.currentEnv = args[0] as Env;
    });
    defineOpcode(vm, "exec.lambda", (vm, args) => {
        const lambda = args[0] as Lambda;
        const argc = args[1] as number;
        const required = lambda.args, nRequired = required.length;
        const optional = lambda.optArgs, nOpt = optional.length;
        const rest = lambda.restArg;
        if ((nRequired + nOpt) > argc) {
            // Need to evaluate defaults.
            const dynamicEnv = new Env({}, [lambda.closureEnv, vm.currentEnv]);
            vm.pushCommand("exec.lambda", lambda, nRequired + nOpt);
            argsHelper(vm, optional.slice(argc - nRequired).map(o => o[1]), true);
            vm.currentEnv = dynamicEnv;
            return NOTHING;
        }
        const callEnv = new Env({}, [lambda.closureEnv]);
        const argv = vm.popNData(argc).reverse();
        for (var n = 0; n < nRequired; n++) {
            callEnv.define(required[n]!, argv[n]);
        }
        for (var n = 0; n < nOpt; n++) {
            callEnv.define(optional[n]![0], argv[nRequired + n]);
        }
        if (rest) {
            callEnv.define(rest, argv.slice(nRequired + nOpt));
        } callEnv.define("return", Continuation.fromVM(vm));
        vm.currentEnv = callEnv;
        implicitBegin(vm, lambda.body);
        return NOTHING;
    });
    function lambdaHelper(name: string, isMacro: boolean, kind: string, extra: string) {
        defineBuiltin(vm, name, { min: 2, max: Infinity }, true, false, (args, vm) => {
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
                        vm.pushCommand("throw", "syntax_error", "required parameter cannot follow optional parameter", {});
                        return NOTHING;
                    }
                    required.push(p);
                } else if (isArray(p)) {
                    if (p.length !== 2) {
                        vm.pushCommand("throw", "syntax_error", "invalid optional argument");
                        return;
                    }
                    optional.push(p);
                } else {
                    vm.pushCommand("throw", "syntax_error", "invalid parameter to lambda", {})
                }
            }
            return new Lambda(isMacro, undefined, required, optional, rest, body, vm.currentEnv, docstring);
        }, `["${name}", [<parameters...:sameline>], <body...>]
["${name}", [<parameters...:sameline>, true], <body...>]
["${name}", [<parameters...:sameline>], <docstring+docstring>, <body...>]

Returns a new anonymous ${kind} with the specified parameters, documentation string, and body.${extra}
If the last element of the argument list is the Boolean \`true\` the last named argument before it becomes a rest argument, that will be an array at runtime filled with all the arguments given after it.
If the \`param\` in the parameters list is a 2-tuple \`[*name*, *default*]\`, then the parameter is optional, and if it is not provided then the value of \`default\` is evaluated in a dynamic environment of both the environment in which the ${name} was defined, as well as the environment from which it was called.
If the first element of \`body\` is a string and there is something additional after it (so that it would otherwise be a no-op), the string is used as the documentation string.`);
    }
    lambdaHelper("lambda", false, "function", "");
    lambdaHelper("macro", true, "macro", "\nA macro differs from a normal function in that its arguments are passed in *before* being evaluated, so the macro body has access to the actual code passed in; additionally, the return value of the macro is expected to be code as well, and is evaluated again the the scope that the macro was called from.");

    // MARK: continuation applier
    defineApplier(vm, new class extends Applier<Continuation> {
        constructor() { super(Continuation); }
        apply(cont: Continuation, _: boolean, __: boolean, args: any[], vm: JebVM) {
            cont.invoke(vm, args[0]);
        }
        // @ts-ignore continuations never show up in a traceback since they replace all 3 stacks!
        getNameOf(): string { }
        getArity() { return 1; }
        getIsMacro() { return false; }
    });

    // MARK: logic
    defineOpcode(vm, "if", (vm, args) => {
        const condition = vm.popData();
        const then = args[0];
        const else_ = args[1];
        const isOpcode = args[2] || false;
        if (isOpcode) {
            // @ts-ignore
            if (condition) { if (then) vm.pushCommand(...then); } else if (else_) vm.pushCommand(...else_);
        } else {
            vm.pushData(condition ? then : else_);
            vm.pushCommand("eval", true);
        }
    });

    defineBuiltin(vm, "if", { min: 2, max: 3 }, true, false, (args, vm) => {
        const condition = args[0];
        const then = args[1];
        const else_ = args[2] ?? null;
        vm.pushCommand("if", then, else_);
        vm.pushCommand("eval");
        vm.pushData(condition);
        return NOTHING;
    }, `["if", <condition>, <code if true>, <code if false>]

Evaluates \`condition\`, and then chooses one of the two branches depending on whether the condition was truthy or falsy. The false branch can be omitted; if there is no false branch and the condition is falsy, the return value is \`null\`.`);

    // MARK: Scheme analogs
    defineBuiltin(vm, "begin", null, true, false, (args, vm) => {
        implicitBegin(vm, args);
        return NOTHING;
    }, `["begin", <statements...>]

Runs each of the body statements in order, and returns the result from the last one. If there are no body statements, the result is \`null\`.`);

    defineBuiltin(vm, "let", null, true, false, (args, vm) => {
        if (isString(args[0])) {
            // rewrite (let loop ((x 1) (y 2)) body) to ((lambda (loop) (set! loop (lambda (x y) body)) (loop 1 2)) null)
            const loopname = args[0];
            const bindings = args[1] as [string, any][];
            const body = args.slice(2);
            const params = bindings.map(b => b[0]);
            const initializers = bindings.map(b => b[1]);
            vm.pushData([["lambda", [loopname], ["set", loopname, ["lambda", params, ...body]], [loopname, ...initializers]], null]);
        } else {
            // rewrite (let ((x 1) (y 2)) body) to ((lambda (x y) body) 1 2)
            const bindings = args[0] as [string, any][];
            const body = args.slice(1);
            const params = bindings.map(b => b[0]);
            const initializers = bindings.map(b => b[1]);
            vm.pushData([["lambda", params, ...body], ...initializers]);
        }
        vm.pushCommand("eval");
        return NOTHING;
    }, `["let", [<pairs...:eachline>], <body...>]
["let", <loopname+define>, [<pairs...:eachline>], <body...>]

Each one of the \`pairs\` is a 2-tuple \`[*name*, *expression*]\`. Each of the expressions will be evaluated in order in the parent environment and the result bound to *name* in the new environment; after all values are bound, the body is evaluated in the new environment.
The second form, where the first argument is a string, allows the lambda body to recursively call itself with new values for each of the variables.
This actually is a macro that expands to an immediately-invoked lambda, so "[lambda]" may show up in the traceback when using \`let\`.`);

    defineBuiltin(vm, "define", null, true, false, (args, vm) => {
        const name = args[0] as string | string[];
        if (typeof name === "boolean" && name && isArray(args[1])) {
            // macro definition: (define true (f x y) body)
            const name2 = args[1];
            const funcName = name2[0] as string;
            const params = name2.slice(1) as string[];
            const body = args.slice(2);
            vm.pushCommand("define", funcName);
            vm.pushCommand("eval");
            vm.pushData(["macro", params, ...body]);
        }
        else if (isString(name)) {
            // variable definition: (define x 10)
            vm.pushCommand("define", name);
            vm.pushCommand("eval");
            vm.pushData(args[1]);
        }
        else if (isArray(name)) {
            // function definition: (define (f x y) body)
            const funcName = name[0] as string;
            const params = name.slice(1) as string[];
            const body = args.slice(1);
            vm.pushCommand("define", funcName);
            vm.pushCommand("eval");
            vm.pushData(["lambda", params, ...body]);
        }
        else {
            vm.pushCommand("throw", "syntax_error", "invalid define syntax", {});
        }
        return NOTHING;
    }, `["define", <varname+define>, <value>]
["define", [<name+define>, <params...:sameline>], <docstring:newline+docstring>, <body...>]
["define", [<name+define>, <params...:sameline>], <body...>]
["define", true, [<name+define>, <params...:sameline>], <docstring:newline+docstring>, <body...>]
["define", true, [<name+define>, <params...:sameline>], <body...>]

Defines a new variable in the current scope.
The first form is a straight \`name=value\`.
The second one expands into a [[lambda]] with the specified name, docstring, parameters, and body (allowing for both rest parameters and the docstring).
The third form (with \`true\`) expands to a [[macro]] in the same way.`);

    // MARK: Operators
    function mathHelper(operator: string, operation: Operation, identity: number,
        numnum: (x: number, y: number) => any,
        bignum: (x: bigint, y: number) => any,
        numbig: (x: number, y: bigint) => any,
        bigbig: (x: bigint, y: bigint) => any,
        num: (x: number) => any,
        big: (x: bigint) => any,
    ) {
        defineBuiltin(vm, operator, null, false, false, (a, vm) => {
            if (a.length === 0) return identity;
            if (a.length === 1) return resultToError(vm, "type_error", vm.math.call(operation, a[0]!));
            var acc = a[0]!;
            for (var i = 1; i < a.length; i++) {
                const res = vm.math.call(operation, acc, a[i]);
                if (!res.ok) {
                    vm.pushCommand("throw", "type_error", res.value, {
                        return: Continuation.fromVM(vm)
                    });
                    return NOTHING;
                }
                acc = res.value;
            }
            return acc;
        }, `["${operator}", <numeric values...>]

Math`);
        vm.math.overload(operation, [["number"], ["number"]], (a, b) => ok(numnum(a, b)));
        vm.math.overload(operation, [["bigint"], ["bigint"]], (a, b) => ok(bigbig(a, b)));
        vm.math.overload(operation, [["bigint"], ["number"]], (a, b) => ok(bignum(a, b)));
        vm.math.overload(operation, [["number"], ["bigint"]], (a, b) => ok(numbig(a, b)));
        vm.math.overload(operation, [["number"]], a => ok(num(a)));
        vm.math.overload(operation, [["bigint"]], a => ok(big(a)));
    }
    const addNumbers = numberOp(add);
    mathHelper("+", "add", 0, addNumbers, addNumbers, addNumbers, addNumbers, id, id);
    vm.math.overload("add", [["string"], ["string"]], (a, b) => ok(a + b));
    const subtractNumbers = numberOp((a, b) => a - b);
    mathHelper("-", "sub", 0, subtractNumbers, subtractNumbers, subtractNumbers, subtractNumbers, a => -a, a => -a);
    const multiplyNumbers = numberOp((a, b) => a * b);
    mathHelper("*", "mul", 1, multiplyNumbers, multiplyNumbers, multiplyNumbers, multiplyNumbers, id, id);
    const divideNumbers = (a: number | bigint, b: number | bigint) => float(a) / float(b);
    mathHelper("/", "div", NaN, divideNumbers, divideNumbers, divideNumbers, divideNumbers, a => 1 / a, a => 1n / a);
    const moduloNumbers = numberOp((a, b) => a % b);
    mathHelper("%", "mod", NaN, moduloNumbers, moduloNumbers, moduloNumbers, moduloNumbers, _ => NaN, _ => NaN);
    const powNumbers = numberOp((a, b) => a ** b);
    mathHelper("pow", "pow", NaN, powNumbers, powNumbers, powNumbers, powNumbers, _ => NaN, _ => NaN);
    const bitAndNumbers = numberOp((a, b) => a & b);
    mathHelper("bit-and", "bitAnd", -1, bitAndNumbers, bitAndNumbers, bitAndNumbers, bitAndNumbers, id, id);
    const bitOrNumbers = numberOp((a, b) => a | b);
    mathHelper("bit-or", "bitOr", 0, bitOrNumbers, bitOrNumbers, bitOrNumbers, bitOrNumbers, id, id);
    const bitXorNumbers = numberOp((a, b) => a ^ b);
    mathHelper("bit-xor", "bitXor", 0, bitXorNumbers, bitXorNumbers, bitXorNumbers, bitXorNumbers, id, id);
    defineBuiltin(vm, "bit-inv", 1, false, false, a => ~a[0], `["bit-inv", <number>]

Math`);

    // comparisons
    function comparisonHelper(op: string, bits: number) {
        defineBuiltin(vm, op, 2, false, false, (args, vm) => resultToError(vm, "type_error", vm.math.call("cmp", args[0], args[1], bits)), `["${op}", <number1>, <number2>]

Comparison`);
    }
    for (var [name, bits] of ([["=", 4], ["!=", 3], ["<", 2], [">", 1], ["<=", 6], [">=", 5]] as [string, number][])) {
        comparisonHelper(name, bits);
    }
    vm.math.overload("cmp", [["number", "bigint"], ["number", "bigint"], ["number"]], (a, b, c) => {
        if (a == b) return ok(!!(c & 4));
        if (a < b) return ok(!!(c & 2));
        if (a > b) return ok(!!(c & 1));
        throw "unreachable";
    });

    // MARK: booleans
    defineBuiltin(vm, "not", 1, false, false, args => !args[0], `["not", <value>]

Boolean inverse`);
    function booleanHelper(name: string, shortCircuitOn: boolean) {
        defineBuiltin(vm, name, null, true, true, (args: any[], vm: JebVM) => {
            if (args.length === 0) {
                return !shortCircuitOn;
            }
            const sym = vm.currentEnv.gensym();
            const rest = [name, ...args.slice(1)];
            const getsym = ["$", sym];
            vm.pushData([["lambda", [sym],
                shortCircuitOn ?
                    ["if", getsym, getsym, rest] :
                    ["if", getsym, rest, getsym]
            ], args[0]]);
            vm.pushCommand("eval", true);
            return NOTHING;
        }, `["${name}", <values...:sameline>]

Boolean ${name.toUpperCase()} (short-circuits)`);
    }
    booleanHelper("and", false);
    booleanHelper("or", true);

    // MARK: lists
    defineBuiltin(vm, "list", null, false, false, a => a, `["list", <values...>]

Returns the arguments in a list`);
    defineBuiltin(vm, "head", 1, false, false, a => a[0][0], `["head", <list>]

Returns the first element of the list`);
    defineBuiltin(vm, "tail", 1, false, false, a => a[0].slice(1), `["tail", <list>]

Returns a copy of the list without the first element`);
    defineBuiltin(vm, "concat", null, false, false, args => {
        const out: any[] = [];
        for (var arg of args) {
            if (!isArray(arg)) {
                vm.pushCommand("throw", "type_error", "not an array to concat", {
                    return: Continuation.fromVM(vm)
                });
                return NOTHING;
            }
            out.push(...arg);
        }
        return out;
    }, `["concat", <lists...>]

Concatenates the lists, and returns a new list`)

    // MARK: metaprogramming
    defineBuiltin(vm, "quote", 1, true, false, a => a[0], `["quote", <value>]
["'", <value>]

Prevents its argument from being evaluated.`);
    alias(vm, "quote", "'");
    defineBuiltin(vm, QUASIQUOTE_NAME, 1, true, true, (args, vm) => {
        const result = processQuasiquote(vm, args[0], 1);
        if (result.ok) {
            return result.value;
        }
        vm.pushCommand("throw", "value_error", result.value, {
            return: Continuation.fromVM(vm)
        });
    }, `["quasiquote", <value>]
["~", <value>]

Prevents its argument from being evaluated, but walks the elements and replaces [[${UNQUOTE_NAME}]] and [[${UNQUOTE_SPLICING_NAME}]] with the results of evaluating their arguments. The argument to [[${UNQUOTE_SPLICING_NAME}]] must be a list.`);
    alias(vm, QUASIQUOTE_NAME, "~");

    defineBuiltin(vm, UNQUOTE_NAME, 1, false, false, (_, vm) => (vm.pushCommand("throw", "value_error", UNQUOTE_NAME + " not valid outside of quasiquote", {
        return: Continuation.fromVM(vm)
    }), NOTHING), `["${UNQUOTE_NAME}", <value>]
[",", <value>]

Marks a value to be interpolated inside a [[${QUASIQUOTE_NAME}]]. This is not valid outside of a [[${QUASIQUOTE_NAME}]] and will throw an error if called as a normal function.`);
    defineBuiltin(vm, UNQUOTE_SPLICING_NAME, 1, false, false, (_, vm) => (vm.pushCommand("throw", "value_error", UNQUOTE_SPLICING_NAME + " not valid outside of quasiquote", {
        return: Continuation.fromVM(vm)
    }), NOTHING), `["${UNQUOTE_SPLICING_NAME}", <value>]
[",@", <value>]

Marks a list to be interpolated via splicing inside a [[${QUASIQUOTE_NAME}]]. This is not valid outside of a [[${QUASIQUOTE_NAME}]] and will throw an error if called as a normal function.`);
    alias(vm, UNQUOTE_NAME, ",");
    alias(vm, UNQUOTE_SPLICING_NAME, ",@");

    defineBuiltin(vm, "parseJSON", 1, false, false, (args, vm) => {
        try {
            return parse(args[0]);
        } catch (e) {
            vm.pushCommand("throw", "value_error", String(e), {});
            return NOTHING;
        }
    }, `["parseJSON", <string>]

Parses the string using \`JSON.parse()\`, and returns the result.`);
    defineBuiltin(vm, "dumpJSON", 1, false, false, (args, vm) => {
        try {
            return stringify(args[0]);
        } catch (e) {
            vm.pushCommand("throw", "value_error", String(e), {});
            return NOTHING;
        }
    }, `["dumpJSON", <value>]

Dumps the value to string using \`JSON.stringify()\`, and returns the serialized JSON. Will throw a \`value_error\` if there is something that can't be serialized, such as a function or circular reference.`);
    defineBuiltin(vm, "log", null, false, false, args => console.log(...args), `["log", <values...>]

Passes the values to \`console.log()\` directly and returns \`undefined\`.`);

    // MARK: JSON based standard library!
    const standardLibrary = ["begin",
        ["define", ["call/cc", "f"],
            `["call/cc", <function>]
["call-with-current-continuation", <function>]

Calls the function with a *continuation*, which is a special callable object. When the continuation is called with one argument, it will not return normally, and instead jump back to the place where \`call/cc\` was created from and make the \`call/cc\` return the given value instead - *even if* the \`call/cc\` expression has already returned!
Invoking a continuation will cause the \`enter\` and \`exit\` handlers of [[with]] blocks jumped across to be triggered with \`true\` to indicate it was due to a continuation.
Continuations can be used for very complex control structures and can be incredibly confusing to debug, so use with care.`,
            ["f", ["$", "return"]]],
        ["define", true, ["when", "test", "body", true],
            `["when", <condition>, <body...>]

Equivalent to \`["[[if]]", *condition*, ["[[begin]]", *body...*]]\`.`,
            [QUASIQUOTE_NAME,
                ["if", [UNQUOTE_NAME, ["$", "test"]],
                    ["begin", [UNQUOTE_SPLICING_NAME, ["$", "body"]]]]]],
        ["define", true, ["unless", "test", "body", true],
            `["unless", <condition>, <body...>]

Equivalent to \`["[[if]]", *condition*, null, ["[[begin]]", *body...*]]\`.`,
            [QUASIQUOTE_NAME,
                ["if", [UNQUOTE_NAME, ["$", "test"]],
                    null,
                    ["begin", [UNQUOTE_SPLICING_NAME, ["$", "body"]]]]]],
        ["define", true, ["try", "body", "handlers"],
            `["try", <body>, <handlers>]

Catches and handles errors. The \`handlers\` is an object mapping error type to handler; it will be expanded using [[obj]].
During evaluation of the body, if an error is thrown, the error's \`type\` (as returned by [[with]]) will be checked to see if it's in the handlers, and if it is, the handler is called with the \`message\` and \`context\` of the error.
If no handler directly matches, the special catch-all handler \`"\\*"\` is tried, and if it exists, it is called with \`type\`, \`message\` and \`context\`.
In both cases if the handler exists, \`true\` is returned to [[with]] to stop propagation of the error. If the handler wants to propagate the error, it should re-throw it using [[error]].
If \`body\` exits cleanly with no error, the special \`"else"\` handler is called with no arguments, if present.`,
            [QUASIQUOTE_NAME, ["let", [["handlers", ["obj", [UNQUOTE_NAME, ["$", "handlers"]]]]],
                ["with", null, ["obj",
                    {
                        exit: ["lambda", ["k", "type", "value", "ctx"],
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
                                    ["handler", ["$", "value"], ["$", "ctx"]],
                                    ["return", true]],
                                ["when", ["$", "starHandler"],
                                    ["starHandler", ["$", "type"], ["$", "value"], ["$", "ctx"]],
                                    ["return", true]],
                                false]],
                    }],
                    [UNQUOTE_NAME, ["$", "body"]]]]]],
        ["define", true, ["with-baffle", "body", true],
            `["with-baffle", <body...>]

Prevents continuations from jumping in or out of \`body\`; only normal control flow or exceptions can be used to enter or exit.`,
            [QUASIQUOTE_NAME, ["with", null, ["obj",
                {
                    enter: ["lambda", ["k"],
                        ["when", ["$", "k"],
                            ["error", "state_error", "Continuation tried to jump into a 'with-baffle' block", {}]],
                        null],
                    exit: ["lambda", ["k", "_", true],
                        ["when", ["$", "k"],
                            ["error", "state_error", "Continuation tried to jump out of a 'with-baffle' block", {}]],
                        false]
                }],
                [UNQUOTE_SPLICING_NAME, ["$", "body"]]]]],
        ["define", ["length", "x"], `["length", <value>]

Returns the length of the value (list or string)`, ["$", ["x", "length"]]],
        ["define", ["zero?", "x"], `["length", <value>]

Returns true if the value is zero.`, ["=", ["$", "x"], 0]],
        ["define", true, ["|>", "value", "items", true],
            `["|>", <value>, <expressions...>]

Pipes the \`value\` as the variable \`#\` into the next expression, and then the result of it becomes the next \`#\`, etc. until all expressions have been evaluated.
This is analogous to Javascript's proposed pipe operator.`,
            ["if", ["zero?", ["length", ["$", "items"]]],
                ["$", "value"],
                [QUASIQUOTE_NAME,
                    [["lambda", ["#"],
                        ["|>", [UNQUOTE_SPLICING_NAME, ["$", "items"]]]],
                    [UNQUOTE_NAME, ["$", "value"]]]]]],
        ["define", ["reduce", "list", "f", "value"],
            `["reduce", <list>, <function>, <value>]

Repeatedly call the function with 2 arguments; the first one is the current \`value\` and the second is each element of \`list\` in turn. The return value will be the new \`value\` for the next element.`,
            // must be recursive because continuations
            // TODO: make this more tail-recursive? it seems to blow the stack for long lists
            ["if", ["zero?", ["length", ["$", "list"]]],
                ["$", "value"],
                ["reduce",
                    ["tail", ["$", "list"]],
                    ["$", "f"],
                    ["f", ["$", "value"], ["head", ["$", "list"]]]]]],
        ["define", ["map", "list_", "f"],
            `["map", <list>, <function>]

Return a new list with the result of applying the function to each element of the list in order.`,
            ["reduce",
                ["$", "list_"],
                ["lambda", ["acc", "cur"],
                    ["concat", ["$", "acc"], ["list", ["f", ["$", "cur"]]]]],
                ["list"]]],
    ];

    vm.currentEnv = vm.globalEnv;
    vm.start(standardLibrary);
    while (vm.step());
    if (vm.paused) throw new Error("Invalid state while setting up stdlib");
    vm.reset();
}
// MARK: end of loadBuiltins();

const QUASIQUOTE_NAME = "quasiquote";
const UNQUOTE_NAME = "unquote";
const UNQUOTE_SPLICING_NAME = "unquoteSplicing";

// MARK: processQuasiquote
function processQuasiquote(vm: JebVM, form: any, depth: number): Result<any> {
    // atoms
    if (!isArray(form)) return ok(form);
    if (form.length === 0) return ok(["quote", []]);

    const h = form[0], t = form.slice(1);

    const same = (x: string, y: string) => vm.getVar(x).value === vm.getVar(y).value;

    // ,x
    if (same(h, UNQUOTE_NAME)) {
        if (form.length !== 2) return err("expected argument to " + UNQUOTE_NAME);
        return ok(depth === 1 ? t[0] : ["list", UNQUOTE_NAME, processQuasiquote(vm, t[0], depth - 1)]);
    }
    // ,@x
    if (same(h, UNQUOTE_SPLICING_NAME)) {
        if (depth !== 1) return ok(["list", UNQUOTE_SPLICING_NAME, processQuasiquote(vm, t[0], depth - 1)]);
        return err(UNQUOTE_SPLICING_NAME + " outside of list");
    }
    // nested `
    if (same(h, QUASIQUOTE_NAME)) {
        if (form.length !== 2) return err("expected argument to " + QUASIQUOTE_NAME);
        return ok(["list", QUASIQUOTE_NAME, processQuasiquote(vm, t[0], depth + 1)]);
    }

    // list – collect chunks, splice where needed
    const parts: any[] = [];
    const buffer: any[] = [];

    var flushFail: Result<any> | undefined;
    const flush = () => {
        if (buffer.length) {
            const part = ["list"];
            for (var e of buffer) {
                const x = processQuasiquote(vm, e, depth);
                if (!x.ok) {
                    flushFail = x;
                    return;
                }
                part.push(x.value);
            }
            parts.push(part);
            buffer.length = 0;
        }
    };

    for (var el of form) {
        if (!isArray(el) || depth !== 1) {
            buffer.push(el);
        }
        else if (same(el[0], UNQUOTE_SPLICING_NAME)) {
            if (el.length !== 2) return err("expected argument to " + UNQUOTE_SPLICING_NAME);
            flush();
            if (flushFail) return flushFail;
            parts.push(el[1]); // ,@x → will be spliced by concat
        } else {
            buffer.push(el);
        }
    }
    flush();
    if (flushFail) return flushFail;

    if (parts.length === 0) return ok(["quote", []]);
    if (parts.length === 1) return ok(parts[0]);
    // (concat part1 part2...)
    return ok(["concat"].concat(parts));
}

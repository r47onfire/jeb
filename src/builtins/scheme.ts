import { isArray } from "lib0/array";
import { Block } from "../block";
import { define, makeJSFun, makeOpcode, NOTHING } from "../define";
import { gensym } from "../env";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { implicitBegin } from "../implicitBegin";
import { AccessType, withType } from "../protocol";
import { VariableReference } from "../reference";
import { Identifier, isIdentifier } from "../utils";
import { Command, JebVM, popData, pushCommand, pushData } from "../vm";
import { B_audit, OP_eval, OP_if, OP_set, OP_shuffle } from "./eval";
import { B_local, B_set } from "./variables";
import { B_fn } from "./callables";
import { B_plus } from "./operators";

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
            if (!isArray(b) || b.length !== 2) throw new JEBError(ErrnoCode.ESYNTAX, "invalid let binding");
        });
        return [bindings.map(b => b[0]), bindings.map(b => b[1])] as const;
    }
    // TODO: rewrite this transformation using Block ??
    if (isIdentifier(args[0])) {
        const loopname = args[0];
        const { 0: params, 1: initializers } = extractParts(withType(args[1], [Array], "let.bindings"));
        const body = args.slice(2);
        const recur = gensym("recur");
        const counter = gensym("counter");
        pushData(vm, [[B_fn, true, [recur],
            [B_set, [B_local, recur],
                [B_fn, true, [counter, ...params],
                    [B_audit, "jeb:loop_check", [B_local, counter]],
                    [B_let_in, loopname, [B_fn, true, params,
                        [recur, [B_plus, 1, [B_local, counter]], ...params.map(p => [B_local, p])]]],
                    ...body]],
            [recur, 0, ...initializers]], 0]);
    } else {
        const { 0: params, 1: initializers } = extractParts(withType(args[0], [Array], "let.bindings"));
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

export const B_let_in = makeJSFun("letIn", [[true, "pairs"], true], ({ pairs: ao }, vm) => {
    const args = ao! as any[];
    const len = args.length;
    if ((len & 1) > 0) {
        throw new JEBError(ErrnoCode.ESYNTAX, "letIn should have an even number of arguments");
    }
    if (len === 0) return null;
    var value;
    const newEnv = vm.createEnv(vm.currentEnv);
    for (var i = 0; i < len; i += 2) {
        const name = args[i];
        value = args[i + 1];
        if (!isIdentifier(name)) {
            throw new JEBError(ErrnoCode.ESYNTAX, "letIn name must be a valid identifier");
        }
        pushData(vm, new VariableReference(AccessType.VARIABLE, newEnv, name));
        pushData(vm, value);
        if (i > 0) pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_set, true, false);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_eval, undefined);
    }
    vm.currentEnv = newEnv;
    return NOTHING;
},
    `.func (letIn name value [name value]...)
..param {string} name
..param {any} value
..returns {any} - the last value
. Creates a new environment with the given name-value pairs as its bindings, and switches to it. Everything after this will be in the new environment.
Functions much like [[let]] but with an implicit block after it that continues to the end of the outer block instead of explicit.
The \`value\`s are in a "letrec" group and will be able to close over each other if they're functions.`);

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
    else throw new JEBError(ErrnoCode.ESYNTAX, "invalid define syntax");
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

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadSchemeBuiltins = (vm: JebVM) => {
    define(vm, "if", B_if);
    define(vm, "begin", B_begin);
    define(vm, "let", B_let);
    define(vm, "letIn", B_let_in);
    define(vm, "define", B_define);
};

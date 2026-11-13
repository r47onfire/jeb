import { isArray } from "lib0/array";
import { makeJSFun } from "./callable";
import { Closure } from "./closure";
import { gensym } from "./env";
import { JSONCode } from "./evaluate";
import {
    OP_eval,
    OP_if_after,
    OP_throw_value,
    seqStart,
    windStart,
} from "./opcodes";
import { parseSignature } from "./signature";
import { Identifier, isIdentifier } from "./utils";
import { JebVM, pushCommand, pushData, SCHEDULED } from "./vm";

/**
 * JEB's builtin procedures, installed into every VM's builtins environment by
 * the {@link JebVM} constructor (see {@link loadBuiltins}).
 *
 * Everything here is an ordinary value in the environment -- there is no
 * special-form syntax in the evaluator. Each builtin is a {@link JSFun}: a host
 * function bundled with a signature in the same parameter forms a `lambda`
 * takes, so argument counts are checked, lazy (backticked) parameters receive
 * raw forms, and rest arguments arrive bundled. Builtins whose parameters are
 * all lazy and which flag their result for re-evaluation (see the
 * `set_macro_result` builtin) are what other languages call macros; user code
 * defines its own exactly the same way, with `lambda`.
 *
 * Pairs like `define`/`%define` split a macro in two: the lazy front end builds
 * an expansion that names the evaluated primitive, so the checking and the side
 * effect live in exactly one place each.
 */

/**
 * Validates a `define`/`assign`-style name form and builds the expansion that
 * calls the evaluated primitive with the name quoted.
 */
const validIdentifier = (vm: JebVM<any, any>, name: unknown): Identifier => {
    if (!isIdentifier(name))
        throw vm.createError("the name must be an identifier");
    return name;
};

export const loadBuiltins = (vm: JebVM<any, any>) => {
    const env = vm.builtinsEnv;
    const def = (fun: ReturnType<typeof makeJSFun>) => {
        env.add(fun.name, fun);
    };

    // MARK: quoting and functions

    /** `quote` returns its argument form as data, unevaluated. */
    def(makeJSFun(vm, "quote", ["`x"], (_vm, x) => x));
    /**
     * `lambda` builds a closure over the current environment. The parameter
     * list is data: names, backticked (lazy) names, [name, default] pairs, and
     * a trailing "...name" rest parameter.
     */
    def(
        makeJSFun(vm, "lambda", ["`params", "...`body"], (vm, params, body) => {
            const signature = parseSignature(vm, params as JSONCode);
            return new Closure(
                signature,
                vm.currentEnv,
                body as unknown as JSONCode[],
            ) as any;
        }),
    );

    // MARK: variables

    def(
        makeJSFun(vm, "define", ["`name", "value"], (vm, name, value) => {
            vm.defineVariable(validIdentifier(vm, name), value, false);
            return value;
        }),
    );
    def(
        makeJSFun(vm, "assign", ["`name", "value"], (vm, name, value) => {
            vm.assignVariable(validIdentifier(vm, name), value);
        }),
    );

    // MARK: let (plain and named/loop forms)

    /**
     * `let` expands to an immediately-called lambda. The named form -- `["let",
     * "loop", bindings, body...]` -- additionally binds the loop name inside
     * the body to a function that re-enters the body with new values; the
     * expansion threads an iteration counter through the recursion and reports
     * each iteration to the audit hooks as a `jeb:loop_check` event, so an
     * embedding application can bound runaway loops.
     */
    def(
        makeJSFun(
            vm,
            "let",
            ["`a", ["`b", null], "...`rest"],
            (vm, a, b, rest) => {
                vm.currentFrame()!.macroResult = true;
                const forms = (rest as unknown as JSONCode[]).slice();
                let loopName: string | undefined;
                let bindingsForm: JSONCode;
                if (typeof a === "string") {
                    loopName = a;
                    bindingsForm = b as JSONCode;
                } else {
                    bindingsForm = a as JSONCode;
                    if (b !== null) forms.unshift(b as JSONCode);
                }
                if (!isArray(bindingsForm))
                    throw vm.createError(
                        "let bindings must be an array of [name, value] pairs",
                    );
                const names: JSONCode[] = [];
                const values: JSONCode[] = [];
                for (let pair of bindingsForm) {
                    if (
                        !isArray(pair) ||
                        pair.length !== 2 ||
                        !isIdentifier(pair[0])
                    )
                        throw vm.createError(
                            "let bindings must be [name, value] pairs",
                        );
                    names.push(pair[0]);
                    values.push(pair[1]!);
                }
                if (loopName === undefined)
                    return [["lambda", names, ...forms], ...values] as any;
                const recur = gensym("recur");
                const counter = gensym("counter");
                const expansion: JSONCode = [
                    [
                        "lambda",
                        [recur],
                        [
                            "assign",
                            recur,
                            [
                                "lambda",
                                [counter, ...names],
                                ["audit", ["quote", "jeb:loop_check"], counter],
                                [
                                    "let",
                                    [
                                        [
                                            loopName,
                                            [
                                                "lambda",
                                                names,
                                                [
                                                    recur,
                                                    ["+", 1, counter],
                                                    ...names,
                                                ],
                                            ],
                                        ],
                                    ],
                                    ...forms,
                                ],
                            ],
                        ],
                        [recur, 0, ...values],
                    ],
                    null,
                ];
                return expansion as any;
            },
        ),
    );

    // MARK: sequencing and conditionals

    def(
        makeJSFun(vm, "begin", ["...`forms"], (vm, forms) => {
            seqStart(vm, forms as unknown as JSONCode[], false);
            return SCHEDULED;
        }),
    );
    /** `comment` swallows its argument forms and produces no value. */
    def(makeJSFun(vm, "comment", ["...`ignored"], (vm) => vm.noValue()));
    def(
        makeJSFun(
            vm,
            "if",
            ["condition", "`branches"],
            (vm, condition, branches) => {
                const forms = branches as unknown as JSONCode[];
                if (forms.length < 1 || forms.length > 2)
                    throw vm.createError("if takes one or two branch forms");
                pushCommand(
                    vm,
                    OP_if_after,
                    forms[0]!,
                    forms[1]!,
                    forms.length === 2,
                    false,
                );
                pushData(vm, condition);
                return SCHEDULED;
            },
        ),
    );

    // MARK: control

    def(
        makeJSFun(
            vm,
            "dynamic_wind",
            ["enter", "body", "exit"],
            (vm, enter, body, exit) => {
                windStart(vm, enter, body, exit, vm.currentFrame()?.source);
                return SCHEDULED;
            },
        ),
    );
    def(
        makeJSFun(vm, "throw", ["value"], (vm, value) => {
            pushData(vm, value);
            pushCommand(vm, OP_throw_value);
            return SCHEDULED;
        }),
    );
    /** `eval` evaluates a value that is code, in the current environment. */
    def(
        makeJSFun(vm, "eval", ["code"], (vm, code) => {
            pushCommand(vm, OP_eval, code as JSONCode, false);
            return SCHEDULED;
        }),
    );
    /**
     * `audit` raises an audit event (see JEBAuditEvents) with a payload, for
     * the embedding application to observe or veto.
     */
    def(
        makeJSFun(vm, "audit", ["event", "param"], (vm, event, param) => {
            (vm.emit as (name: string, arg?: any) => void)(
                String(event),
                param,
            );
            return vm.noneValue();
        }),
    );

    // MARK: the span-injection builtins
    //
    // These address the call that invoked them (see
    // JebVM.callerFrame / JebVM.callerEntry): a primitive procedure calls
    // them to fix up how its own call is recorded.

    def(
        makeJSFun(vm, "set_macro_result", ["value"], (vm, value) => {
            const frame = vm.callerFrame();
            if (frame) frame.macroResult = vm.isTruthy(value);
            return vm.booleanValue(!!frame && vm.isTruthy(value));
        }),
    );
    def(
        makeJSFun(vm, "hide_call", ["value"], (vm, value) => {
            const entry = vm.callerEntry();
            if (entry) entry.hidden = vm.isTruthy(value);
            return vm.booleanValue(!!entry);
        }),
    );
    def(
        makeJSFun(vm, "redirect_call", ["param"], (vm, param) => {
            const entry = vm.callerEntry();
            const frame = vm.callerFrame();
            const index = typeof param === "number" ? param : -1;
            if (
                entry &&
                frame &&
                index >= 0 &&
                frame.argSources[index] !== undefined
            )
                entry.source = frame.argSources[index]!;
            return vm.noValue();
        }),
    );
    def(
        makeJSFun(
            vm,
            "throw_runtime_error",
            ["param", "message"],
            (vm, param, message) => {
                // drop this call's own traceback entry, if it is the top one:
                // the error is blamed on the invoking call, not on this builtin
                const own = vm.currentFrame();
                let top = vm.tracebackStack;
                if (top && own && top.value.item.name === own.name)
                    vm.popTraceback(false);
                const entry = vm.callerEntry();
                const frame = vm.callerFrame();
                if (
                    entry &&
                    frame &&
                    typeof param === "number" &&
                    frame.argSources[param] !== undefined
                )
                    entry.source = frame.argSources[param]!;
                throw vm.createError(String(message));
            },
        ),
    );

    // MARK: lists (arrays), for code that builds or walks forms

    const asArray = (
        vm: JebVM<any, any>,
        callee: string,
        value: unknown,
    ): unknown[] => {
        if (!isArray(value))
            throw vm.createError(`${callee}: expected an array`);
        return value;
    };
    def(makeJSFun(vm, "list", ["...args"], (_vm, args) => args));
    def(
        makeJSFun(vm, "cons", ["x", "array"], (vm, x, array) => {
            return [x, ...asArray(vm, "cons", array)] as any;
        }),
    );
    def(
        makeJSFun(vm, "append", ["...arrays"], (vm, arrays) => {
            return (arrays as unknown as unknown[][]).flatMap((a) =>
                asArray(vm, "append", a),
            ) as any;
        }),
    );
    def(
        makeJSFun(vm, "first", ["array"], (vm, array) => {
            const items = asArray(vm, "first", array);
            if (items.length === 0) throw vm.createError("first: empty array");
            return items[0] as any;
        }),
    );
    def(
        makeJSFun(vm, "rest", ["array"], (vm, array) => {
            return asArray(vm, "rest", array).slice(1) as any;
        }),
    );
    def(
        makeJSFun(vm, "length", ["array"], (vm, array) => {
            return vm.wrapNumber(asArray(vm, "length", array).length);
        }),
    );
};

import { describe, expect, test } from "bun:test";
import {
    ErrnoCode,
    IRNode,
    JEBError,
    JebVM,
    markExpansion,
    nodeSource,
    NO_VALUE,
    op,
    OP_eval,
    popData,
    pushCommand,
    pushData,
    sourcesEqual,
    StackTreeNode,
} from "../src";

// Tests use strings as spans (the IR is generic over the span type).
type N = IRNode<string>;
const n = (name: string, ...operands: any[]): N =>
    op<string>(name, undefined, ...operands);
const ns = (name: string, span: string, ...operands: any[]): N =>
    op<string>(name, span, ...operands);
const c = (value: any): N => n("const", value);
const v = (name: string): N => n("var", name);
const call = (name: string, ...args: any[]): N =>
    n("call", v(name), ...args);

const makeVM = () => {
    const vm = new JebVM();
    const out: string[] = [];
    vm.defineHostFunction("+", (_vm, a, b) => a + b);
    vm.defineHostFunction("-", (_vm, a, b) => a - b);
    vm.defineHostFunction("*", (_vm, a, b) => a * b);
    vm.defineHostFunction("=", (_vm, a, b) => a === b);
    vm.defineHostFunction("<", (_vm, a, b) => a < b);
    vm.defineHostFunction("list", (_vm, ...args) => args);
    vm.defineHostFunction("print", (_vm, ...args) => {
        out.push(args.map(String).join(" "));
        return NO_VALUE;
    });
    vm.defineHostFunction("boom", () => {
        throw new JEBError(ErrnoCode.EFAIL, "boom");
    });
    return { vm, out };
};

const run = (vm: JebVM, code: N) => {
    vm.start(code);
    while (!vm.done && !vm.error) vm.step();
    if (vm.error) throw vm.error;
    return popData(vm);
};

const runAsync = async (vm: JebVM, code: N) => {
    vm.start(code);
    while (!vm.done && !vm.error) {
        if (vm.paused) await vm.awaiting;
        else vm.step();
    }
    if (vm.error) throw vm.error;
    return popData(vm);
};

const leafNames = (nodes: StackTreeNode[] | undefined): string[] =>
    (nodes ?? []).flatMap((node) =>
        node.leaf ? [String(node.name)] : leafNames(node.children),
    );

describe("nodes and sources", () => {
    test("a bare span is normalized into a SourceInfo", () => {
        expect(nodeSource(ns("seq", "s1"))).toEqual({ span: "s1" });
        expect(nodeSource(n("seq"))).toBeUndefined();
    });
    test("sources compare by span and expansion chain", () => {
        const a = nodeSource(ns("seq", "x"));
        const b = nodeSource(ns("seq", "x"));
        const d = nodeSource(ns("seq", "y"));
        expect(sourcesEqual(a, b)).toBe(true);
        expect(sourcesEqual(a, d)).toBe(false);
        expect(sourcesEqual(a, undefined)).toBe(false);
    });
    test("markExpansion stamps the root and chains outward", () => {
        const inner = markExpansion(ns("call", "template"), {
            span: "inner-call",
        });
        expect(nodeSource(inner)).toEqual({
            span: "template",
            expandedFrom: { span: "inner-call" },
        });
        const outer = markExpansion(inner, { span: "outer-call" });
        expect(nodeSource(outer)?.expandedFrom).toEqual({
            span: "inner-call",
            expandedFrom: { span: "outer-call" },
        });
        // the original node is not mutated
        expect(nodeSource(inner)?.expandedFrom).toEqual({
            span: "inner-call",
        });
    });
});

describe("const, seq, and no value", () => {
    test("const returns its operand unevaluated, even if node-shaped", () => {
        const { vm } = makeVM();
        const data = ["call", undefined, ["var", undefined, "boom"]];
        const result = run(vm, c(data));
        expect(result).toBe(data);
    });
    test("seq returns its last value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", c(1), c(2), c(3)))).toBe(3);
    });
    test("an empty seq is no value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq"))).toBe(NO_VALUE);
    });
    test("comment evaluates nothing and produces no value", () => {
        const { vm } = makeVM();
        // the operand would throw if it were ever evaluated
        expect(run(vm, n("comment", call("boom")))).toBe(NO_VALUE);
        expect(run(vm, n("comment", op("no-such-opcode", undefined)))).toBe(
            NO_VALUE,
        );
    });
    test("a trailing comment does not clobber a seq's value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", c(42), n("comment", "note")))).toBe(42);
    });
    test("define is a statement: it produces no value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", n("define", "x", c(1)), c(5)))).toBe(5);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("define", "x", c(1)))).toBe(NO_VALUE);
    });
});

describe("variables and let", () => {
    test("define then var", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", n("define", "x", c(10)), v("x")))).toBe(10);
    });
    test("assign updates an existing variable", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n("seq", n("define", "x", c(1)), n("assign", "x", c(2)), v("x")),
            ),
        ).toBe(2);
    });
    test("assign to an undefined variable throws ENAME", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, n("assign", "nope", c(1)));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.code).toBe(ErrnoCode.ENAME);
    });
    test("reading an undefined variable throws ENAME", () => {
        const { vm } = makeVM();
        expect(() => run(vm, v("nope"))).toThrow(JEBError);
    });
    test("a constant cannot be assigned", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                n(
                    "seq",
                    n("define-const", "x", c(1)),
                    n("assign", "x", c(2)),
                ),
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.code).toBe(ErrnoCode.EPERM);
    });
    test("let binds in a child scope and leaves the outer scope alone", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n("define", "x", c(1)),
                    n("let", n("bind", "x", c(2)), v("x")),
                ),
            ),
        ).toBe(2);
        const { vm: vm2 } = makeVM();
        expect(
            run(
                vm2,
                n(
                    "seq",
                    n("define", "x", c(1)),
                    n("let", n("bind", "x", c(2)), c(0)),
                    v("x"),
                ),
            ),
        ).toBe(1);
    });
    test("let binding values are evaluated in the outer scope", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n("define", "x", c(10)),
                    n(
                        "let",
                        n("bind", "y", call("+", v("x"), c(1))),
                        v("y"),
                    ),
                ),
            ),
        ).toBe(11);
        // a binding cannot see its siblings
        const { vm: vm2 } = makeVM();
        expect(() =>
            run(
                vm2,
                n("let", n("bind", "a", c(1)), n("bind", "b", v("a")), v("b")),
            ),
        ).toThrow(JEBError);
    });
    test("bind outside a let is an error", () => {
        const { vm } = makeVM();
        expect(() => run(vm, n("bind", "x", c(1)))).toThrow(JEBError);
    });
});

describe("functions", () => {
    test("lambda and call", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "call",
                    n("lambda", ["a", "b"], call("+", v("a"), v("b"))),
                    c(3),
                    c(4),
                ),
            ),
        ).toBe(7);
    });
    test("closures capture their defining environment", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n(
                        "define",
                        "make-adder",
                        n(
                            "lambda",
                            ["x"],
                            n("lambda", ["y"], call("+", v("x"), v("y"))),
                        ),
                    ),
                    n(
                        "let",
                        n("bind", "add2", call("make-adder", c(2))),
                        call("add2", c(3)),
                    ),
                ),
            ),
        ).toBe(5);
    });
    test("recursion through a defined name", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n(
                        "define",
                        "fact",
                        n(
                            "lambda",
                            ["k"],
                            n(
                                "if",
                                call("<", v("k"), c(2)),
                                c(1),
                                call(
                                    "*",
                                    v("k"),
                                    call("fact", call("-", v("k"), c(1))),
                                ),
                            ),
                        ),
                    ),
                    call("fact", c(5)),
                ),
            ),
        ).toBe(120);
    });
    test("deep tail recursion does not grow the JS stack", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n(
                        "define",
                        "count",
                        n(
                            "lambda",
                            ["k"],
                            n(
                                "if",
                                call("=", v("k"), c(0)),
                                c(0),
                                call("count", call("-", v("k"), c(1))),
                            ),
                        ),
                    ),
                    call("count", c(20000)),
                ),
            ),
        ).toBe(0);
    });
    test("rest parameters collect the remaining arguments", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "call",
                    n("lambda", ["first", "...rest"], v("rest")),
                    c(1),
                    c(2),
                    c(3),
                ),
            ),
        ).toEqual([2, 3]);
    });
    test("arity is checked", () => {
        const { vm } = makeVM();
        expect(() =>
            run(vm, n("call", n("lambda", ["a"], v("a")))),
        ).toThrow(JEBError);
        const { vm: vm2 } = makeVM();
        expect(() =>
            run(vm2, n("call", n("lambda", ["a"], v("a")), c(1), c(2))),
        ).toThrow(JEBError);
    });
    test("calling a non-callable throws EFUNC", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, n("call", c(42)));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.code).toBe(ErrnoCode.EFUNC);
    });
    test("a function body ending in a comment returns its real value", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n(
                        "define",
                        "f",
                        n("lambda", [], c(99), n("comment", "note")),
                    ),
                    call("f"),
                ),
            ),
        ).toBe(99);
    });
    test("a host function returning NO_VALUE does not clobber a seq", () => {
        const { vm, out } = makeVM();
        expect(
            run(vm, n("seq", c(1), call("print", c("hi")), c(2))),
        ).toBe(2);
        expect(out).toEqual(["hi"]);
    });
    test("an async host function's result is awaited", async () => {
        const { vm } = makeVM();
        vm.defineHostFunction("later", async () => 5);
        expect(
            await runAsync(vm, call("+", call("later"), c(1))),
        ).toBe(6);
    });
    test("tracebacks name the call chain with its spans", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                n(
                    "seq",
                    n(
                        "define",
                        "f",
                        n("lambda", [], ns("call", "inner", v("boom"))),
                    ),
                    ns("call", "outer", v("f")),
                ),
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(leafNames(err.traceback)).toEqual(["boom", "f"]);
        const leaves = (err.traceback as StackTreeNode[]).filter(
            (node) => node.leaf,
        );
        expect(leaves[0]!.leaf && leaves[0]!.source?.span).toBe("inner");
        expect(leaves[1]!.leaf && leaves[1]!.source?.span).toBe("outer");
    });
});

describe("if", () => {
    test("branches on host truthiness", () => {
        const { vm } = makeVM();
        expect(run(vm, n("if", c(true), c(1), c(2)))).toBe(1);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("if", c(0), c(1), c(2)))).toBe(2);
    });
    test("a missing else produces no value, and the untaken branch is skipped", () => {
        const { vm } = makeVM();
        expect(run(vm, n("if", c(false), call("boom")))).toBe(NO_VALUE);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("if", c(true), c(1), call("boom")))).toBe(1);
    });
});

// test-only continuation step for the "twice" opcode: drops the first
// result and evaluates the operand a second time
const OP_twice_step = (vm: JebVM, [node]: [any]) => {
    popData(vm);
    pushCommand(vm, OP_eval, node, false);
};

describe("host-defined opcodes", () => {
    test("an opcode can evaluate an operand more than once", () => {
        const { vm } = makeVM();
        let count = 0;
        vm.defineHostFunction("tick", () => ++count);
        vm.defineOpcode("twice", (vm, ctx) => {
            pushCommand(vm, OP_twice_step, ctx.operands[0]);
            ctx.eval(ctx.operands[0]);
        });
        expect(run(vm, n("twice", call("tick")))).toBe(2);
        expect(count).toBe(2);
    });
    test("an opcode can skip an operand (macro-style)", () => {
        const OP_unless_after = (
            vm: JebVM,
            [{ then, els, tail }]: [{ then: any; els: any; tail: boolean }],
        ) => {
            const condition = popData(vm);
            if (!condition) pushCommand(vm, OP_eval, then, tail);
            else if (els !== undefined) pushCommand(vm, OP_eval, els, tail);
            else pushData(vm, NO_VALUE);
        };
        const defineUnless = (vm: JebVM) =>
            vm.defineOpcode("unless", (vm, ctx) => {
                pushCommand(vm, OP_unless_after, {
                    then: ctx.operands[1],
                    els: ctx.operands[2],
                    tail: ctx.tail,
                });
                ctx.eval(ctx.operands[0]);
            });
        const { vm } = makeVM();
        defineUnless(vm);
        expect(run(vm, n("unless", c(false), c(1), c(2)))).toBe(1);
        const { vm: vm2 } = makeVM();
        defineUnless(vm2);
        // the skipped branch would throw if evaluated
        expect(run(vm2, n("unless", c(true), call("boom"), c(2)))).toBe(2);
    });
    test("opcode names cannot be registered twice", () => {
        const { vm } = makeVM();
        expect(() => vm.defineOpcode("seq", () => {})).toThrow(Error);
    });
    test("an unknown opcode is a syntax error", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, op("frobnicate", undefined, c(1)) as N);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.code).toBe(ErrnoCode.ESYNTAX);
    });
});

describe("eval and macro expansion sources", () => {
    test("eval evaluates code produced at runtime", () => {
        const { vm } = makeVM();
        expect(run(vm, n("eval", c(call("+", c(1), c(2)))))).toBe(3);
    });
    test("eval of a non-node is a syntax error", () => {
        const { vm } = makeVM();
        expect(() => run(vm, n("eval", c(42)))).toThrow(JEBError);
    });
    test("errors in expanded code carry the expansion source", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                ns(
                    "eval",
                    "macro-call-site",
                    c(ns("call", "template", v("boom"))),
                ),
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        const leaves = (err.traceback as StackTreeNode[]).filter(
            (node) => node.leaf,
        );
        expect(leaves).toHaveLength(1);
        const leaf = leaves[0]!;
        expect(leaf.leaf && leaf.name).toBe("boom");
        expect(leaf.leaf && leaf.source?.span).toBe("template");
        expect(leaf.leaf && leaf.source?.expandedFrom?.span).toBe(
            "macro-call-site",
        );
        // the expansion context is cleaned up after the error
        expect(vm.expansionStack).toHaveLength(0);
    });
});

describe("continuations and dynamic-wind", () => {
    test("callcc escapes with the continuation's value", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "callcc",
                    n("lambda", ["k"], n("call", v("k"), c(42)), c(0)),
                ),
            ),
        ).toBe(42);
    });
    test("callcc without escaping returns the body's value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("callcc", n("lambda", ["k"], c(7))))).toBe(7);
    });
    test("dynamic-wind runs enter, body, and exit in order", () => {
        const { vm, out } = makeVM();
        const thunk = (label: string) =>
            n("lambda", [], call("print", c(label)));
        // exit handlers take the error (or null) as an argument
        const exit = n("lambda", ["err"], call("print", c("exit")));
        run(vm, n("dynamic-wind", thunk("enter"), thunk("body"), exit));
        expect(out).toEqual(["enter", "body", "exit"]);
    });
    test("escaping through a dynamic-wind still runs its exit handler", () => {
        const { vm, out } = makeVM();
        const result = run(
            vm,
            n(
                "callcc",
                n(
                    "lambda",
                    ["k"],
                    n(
                        "dynamic-wind",
                        n("lambda", [], call("print", c("enter"))),
                        n("lambda", [], n("call", v("k"), c("escaped"))),
                        n("lambda", ["err"], call("print", c("exit"))),
                    ),
                ),
            ),
        );
        expect(result).toBe("escaped");
        expect(out).toEqual(["enter", "exit"]);
    });
    test("throw runs dynamic-wind exit handlers with the error", () => {
        const { vm, out } = makeVM();
        let err: any;
        try {
            run(
                vm,
                n(
                    "dynamic-wind",
                    n("lambda", [], c(null)),
                    n("lambda", [], n("throw", c("bad"))),
                    n(
                        "lambda",
                        ["err"],
                        call("print", c("exit")),
                    ),
                ),
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("bad");
        expect(out).toEqual(["exit"]);
    });
});

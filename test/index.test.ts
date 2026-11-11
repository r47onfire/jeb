import { describe, expect, test } from "bun:test";
import {
    Block,
    Closure,
    JEBError,
    JebVM,
    OP_eval,
    OP_if_after,
    OpcodeContext,
    popData,
    pushCommand,
    pushData,
    seqStart,
    sourcesEqual,
    StackTreeNode
} from "../src";
import {
    makeTestRun,
    markExpansion,
    NO_VALUE,
    nodeSource,
    op,
    run,
    runAsync,
    TestIRNode,
    TestVM,
} from "../src/indextest";

// Tests use strings as spans (the IR is generic over the span type).
const n = (name: string, ...operands: any[]): TestIRNode =>
    op(name, undefined, ...operands);
const ns = (name: string, span: string, ...operands: any[]): TestIRNode =>
    op(name, span, ...operands);
const c = (value: any): TestIRNode => n("const", value);
const v = (name: string): TestIRNode => n("var", name);
const call = (name: string, ...args: any[]): TestIRNode =>
    n("call", v(name), ...args);

const makeVM = () => {
    const vm = new TestVM();
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
    vm.defineHostFunction("boom", (vm) => {
        throw vm.createError("boom");
    });
    return { vm, out };
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
    test("an empty seq is none", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq"))).toBe(vm.noneValue());
    });
    test("a seq of only comments is none", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", n("comment", "a"), n("comment", "b")))).toBe(
            null,
        );
    });
    test("comment evaluates nothing and produces no value", () => {
        const { vm } = makeVM();
        // the operand would throw if it were ever evaluated
        expect(run(vm, n("comment", call("boom")))).toBe(vm.noValue());
        expect(run(vm, n("comment", op("no-such-opcode", undefined)))).toBe(
            vm.noValue(),
        );
    });
    test("a trailing comment does not clobber a seq's value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", c(42), n("comment", "note")))).toBe(42);
    });
    test("define is an expression: it produces the value", () => {
        const { vm } = makeVM();
        expect(run(vm, n("seq", n("define", "x", c(1)), c(5)))).toBe(5);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("define", "x", c(1)))).toBe(1);
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
    test("assign to an undefined variable is an error", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, n("assign", "nope", c(1)));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe(
            "cannot assign to undefined variable: nope",
        );
    });
    test("reading an undefined variable is an error", () => {
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
        expect(err.message).toBe("cannot assign to constant: x");
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
    test("calling a non-callable is an error", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, n("call", c(42)));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("value is not callable: number");
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

describe("blocks", () => {
    test("a lambda's value is a closure wrapping a block", () => {
        const { vm } = makeVM();
        const result = run(vm, n("lambda", ["a"], v("a")));
        expect(result).toBeInstanceOf(Closure);
        expect(result.block).toBeInstanceOf(Block);
        expect(result.block.body).toHaveLength(1);
        expect(result.env).toBe(result.block.closureEnv);
    });
    test("creating a block does not evaluate its body", () => {
        const { vm } = makeVM();
        let count = 0;
        vm.defineHostFunction("tick", () => ++count);
        run(vm, n("block", call("tick")));
        expect(count).toBe(0);
    });
    test("invoking a block evaluates it in its captured environment", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                n(
                    "seq",
                    n("define", "b", c(null)),
                    n(
                        "let",
                        n("bind", "x", c(2)),
                        n("assign", "b", n("block", v("x"))),
                    ),
                    n("call", v("b")),
                ),
            ),
        ).toBe(2);
    });
    test("a block can be invoked more than once", () => {
        const { vm } = makeVM();
        let count = 0;
        vm.defineHostFunction("tick", () => ++count);
        expect(
            run(
                vm,
                n(
                    "seq",
                    n("define", "b", n("block", call("tick"))),
                    n("call", v("b")),
                    n("call", v("b")),
                ),
            ),
        ).toBe(2);
        expect(count).toBe(2);
    });
    test("a block passed as an argument is a lazy parameter", () => {
        const { vm } = makeVM();
        let count = 0;
        vm.defineHostFunction("tick", () => ++count);
        // the callee invokes the block: the argument is evaluated, once
        expect(
            run(
                vm,
                n(
                    "call",
                    n("lambda", ["b"], n("call", v("b"))),
                    n("block", call("tick")),
                ),
            ),
        ).toBe(1);
        expect(count).toBe(1);
        // the callee ignores the block: the argument is never evaluated
        const { vm: vm2 } = makeVM();
        let count2 = 0;
        vm2.defineHostFunction("tick", () => ++count2);
        expect(
            run(
                vm2,
                n(
                    "call",
                    n("lambda", ["b"], c(0)),
                    n("block", call("tick")),
                ),
            ),
        ).toBe(0);
        expect(count2).toBe(0);
    });
    test("blocks take no arguments", () => {
        const { vm } = makeVM();
        expect(() =>
            run(vm, n("call", n("block", c(1)), c(2))),
        ).toThrow(JEBError);
    });
});

describe("if", () => {
    test("branches on host truthiness", () => {
        const { vm } = makeVM();
        expect(run(vm, n("if", c(true), c(1), c(2)))).toBe(1);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("if", c(0), c(1), c(2)))).toBe(2);
    });
    test("a missing else produces none, and the untaken branch is skipped", () => {
        const { vm } = makeVM();
        expect(run(vm, n("if", c(false), call("boom")))).toBe(vm.noneValue());
        const { vm: vm2 } = makeVM();
        expect(run(vm2, n("if", c(true), c(1), call("boom")))).toBe(1);
    });
});

// test-only continuation step for the "twice" opcode: drops the first
// result and evaluates the operand a second time
const OP_twice_step = (vm: JebVM<any, any>, [node]: [any]) => {
    popData(vm);
    pushCommand(vm, OP_eval, node, false);
};

describe("host-defined opcodes", () => {
    test("an opcode can evaluate an operand more than once", () => {
        const { vm } = makeVM();
        let count = 0;
        vm.defineHostFunction("tick", () => ++count);
        vm.defineOpcode("twice", (vm: JebVM<any, any>, ctx: OpcodeContext<any>) => {
            pushCommand(vm, OP_twice_step, ctx.operands[0]);
            ctx.eval(ctx.operands[0]!);
        });
        expect(run(vm, n("twice", call("tick")))).toBe(2);
        expect(count).toBe(2);
    });
    test("an opcode can skip an operand (macro-style)", () => {
        const OP_unless_after = (
            vm: JebVM<any, any>,
            [{ then, els, tail }]: [{ then: any; els: any; tail: boolean }],
        ) => {
            const condition = popData(vm);
            if (!condition) pushCommand(vm, OP_eval, then, tail);
            else if (els !== undefined) pushCommand(vm, OP_eval, els, tail);
            else pushData(vm, NO_VALUE);
        };
        const defineUnless = (vm: JebVM<any, any>) =>
            vm.defineOpcode("unless", (vm: JebVM<any, any>, ctx: OpcodeContext<any>) => {
                pushCommand(vm, OP_unless_after, {
                    then: ctx.operands[1],
                    els: ctx.operands[2],
                    tail: ctx.tail,
                });
                ctx.eval(ctx.operands[0]!);
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
        expect(() => vm.defineOpcode("seq", () => { })).toThrow(Error);
    });
    test("an unknown opcode is a syntax error", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, op("frobnicate", undefined, c(1)) as TestIRNode);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("unknown opcode: frobnicate");
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
        // enter handlers take an isFromContinuation flag; exit handlers
        // take the error (or null) and the same flag
        const enter = n("lambda", ["cont"], call("print", c("enter")));
        const exit = n("lambda", ["err", "cont"], call("print", c("exit")));
        run(vm, n("dynamic-wind", enter, thunk("body"), exit));
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
                        n("lambda", ["cont"], call("print", c("enter"))),
                        n("lambda", [], n("call", v("k"), c("escaped"))),
                        n("lambda", ["err", "cont"], call("print", c("exit"))),
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
                    n("lambda", ["cont"], c(null)),
                    n("lambda", [], n("throw", c("bad"))),
                    n(
                        "lambda",
                        ["err", "cont"],
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

describe("recoverable errors", () => {
    test("an exit handler can cancel error propagation by returning true", () => {
        const { vm } = makeVM();
        const result = run(
            vm,
            n(
                "seq",
                n("define", "seen", c(null)),
                n(
                    "dynamic-wind",
                    n("lambda", ["cont"], c(null)),
                    n("lambda", [], call("boom")),
                    n(
                        "lambda",
                        ["err", "cont"],
                        n("seq", n("assign", "seen", v("err")), c(true)),
                    ),
                ),
                c(42),
            ),
        );
        // execution continued past the dynamic-wind, and no error is parked
        expect(result).toBe(42);
        expect(vm.error).toBeUndefined();
        // ...and the exit handler was called with the error
        const seen = run(vm, v("seen"));
        expect(seen).toBeInstanceOf(JEBError);
        expect((seen as JEBError).message).toBe("boom");
    });
    test("an exit handler returning anything else lets the error propagate", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                n(
                    "dynamic-wind",
                    n("lambda", ["cont"], c(null)),
                    n("lambda", [], call("boom")),
                    n("lambda", ["err", "cont"], c(false)),
                ),
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("boom");
    });
    test("cancellation stops at the innermost handler that returns true", () => {
        const { vm, out } = makeVM();
        run(
            vm,
            n(
                "dynamic-wind",
                n("lambda", ["cont"], c(null)),
                n(
                    "lambda",
                    [],
                    n(
                        "dynamic-wind",
                        n("lambda", ["cont"], c(null)),
                        n("lambda", [], call("boom")),
                        n(
                            "lambda",
                            ["err", "cont"],
                            n("seq", call("print", c("inner")), c(true)),
                        ),
                    ),
                ),
                n("lambda", ["err", "cont"], call("print", v("err"))),
            ),
        );
        expect(vm.error).toBeUndefined();
        // the inner handler caught the error; the outer wind then exited
        // normally, so its exit handler ran with null, not the error
        expect(out).toEqual(["inner", "null"]);
    });
    test("a dynamic-wind whose exit handler cancels produces none", () => {
        const { vm } = makeVM();
        const result = run(
            vm,
            n(
                "seq",
                c(7),
                n(
                    "dynamic-wind",
                    n("lambda", ["cont"], c(null)),
                    n("lambda", [], call("boom")),
                    n("lambda", ["err", "cont"], c(true)),
                ),
            ),
        );
        expect(result).toBe(vm.noneValue());
    });
    test("try/catch is buildable from dynamic-wind plus cancellation", () => {
        const { vm } = makeVM();
        // (try body) evaluates to the body's value, or to "caught" if the
        // body threw: the exit handler stashes the error in `caught` and
        // returns true to cancel it, and the code after the wind decides.
        const try_ = (body: TestIRNode) =>
            n(
                "seq",
                n("define", "caught", c(null)),
                n("define", "result", c(null)),
                n(
                    "dynamic-wind",
                    n("lambda", ["cont"], c(null)),
                    n("lambda", [], n("assign", "result", body)),
                    n(
                        "lambda",
                        ["err", "cont"],
                        n(
                            "if",
                            v("err"),
                            n("seq", n("assign", "caught", v("err")), c(true)),
                            c(false),
                        ),
                    ),
                ),
                n("if", v("caught"), c("caught"), v("result")),
            );
        expect(run(vm, try_(call("+", c(1), c(2))))).toBe(3);
        expect(run(vm, try_(call("boom")))).toBe("caught");
    });
});

describe("argument evaluation is the callee's business", () => {
    test("a block callee never evaluates its rejected arguments", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            // the argument would throw if it were ever evaluated
            run(vm, n("call", n("block", c(1)), call("boom")));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe(
            "too many arguments: a block takes none, got 1",
        );
    });
    test("a non-callable callee is rejected before its arguments evaluate", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, n("call", c(42), call("boom")));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("value is not callable: number");
    });
    test("arguments evaluate in the call site's environment", () => {
        const { vm } = makeVM();
        // `z` exists only in the let's environment (the call site); the
        // closure was defined at the top level, where there is no `z`
        const program = n(
            "seq",
            n("define", "add", n("lambda", ["a", "b"], call("+", v("a"), v("b")))),
            n(
                "let",
                n("bind", "z", c(10)),
                call("add", v("z"), c(5)),
            ),
        );
        expect(run(vm, program)).toBe(15);
    });
});

const testWind = makeTestRun(makeVM);

describe("dynamic-wind handler flags", () => {
    const enter = () =>
        n(
            "lambda",
            ["cont"],
            n(
                "if",
                v("cont"),
                call("print", c("enter-cont")),
                call("print", c("enter")),
            ),
        );
    const exit = () =>
        n("lambda", ["err", "cont"], call("print", v("err"), v("cont")));
    testWind(
        test,
        "a normal pass calls enter and exit with isFromContinuation false",
        (vm, out) => {
            run(
                vm,
                n(
                    "dynamic-wind",
                    enter(),
                    n("lambda", [], call("print", c("body"))),
                    exit(),
                ),
            );
            expect(out).toEqual(["enter", "body", "null false"]);
        },
    );
    testWind(
        test,
        "escaping through a wind calls its exit with isFromContinuation true",
        (vm, out) => {
            const result = run(
                vm,
                n(
                    "callcc",
                    n(
                        "lambda",
                        ["k"],
                        n(
                            "dynamic-wind",
                            enter(),
                            n(
                                "lambda",
                                [],
                                n("call", v("k"), c("escaped")),
                            ),
                            exit(),
                        ),
                    ),
                ),
            );
            expect(result).toBe("escaped");
            expect(out).toEqual(["enter", "null true"]);
        },
    );
    testWind(
        test,
        "re-entering through a continuation calls enter with isFromContinuation true",
        (vm, out) => {
            const result = run(
                vm,
                n(
                    "seq",
                    n("define", "k", c(null)),
                    n("define", "first", c(true)),
                    n(
                        "dynamic-wind",
                        enter(),
                        n(
                            "lambda",
                            [],
                            n(
                                "seq",
                                n(
                                    "callcc",
                                    n(
                                        "lambda",
                                        ["cc"],
                                        n("assign", "k", v("cc")),
                                    ),
                                ),
                                call("print", c("body")),
                            ),
                        ),
                        exit(),
                    ),
                    n(
                        "if",
                        v("first"),
                        n(
                            "seq",
                            n("assign", "first", c(false)),
                            n("call", v("k"), c(null)),
                        ),
                        c("done"),
                    ),
                ),
            );
            expect(result).toBe("done");
            expect(out).toEqual([
                "enter",
                "body",
                "null false",
                "enter-cont",
                "body",
                "null false",
            ]);
        },
    );
    testWind(
        test,
        "a throw calls exit with the error and isFromContinuation false",
        (vm, out) => {
            let err: any;
            try {
                run(
                    vm,
                    n(
                        "dynamic-wind",
                        enter(),
                        n("lambda", [], call("boom")),
                        n(
                            "lambda",
                            ["err", "cont"],
                            call("print", v("cont")),
                        ),
                    ),
                );
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(JEBError);
            expect(err.message).toBe("boom");
            expect(out).toEqual(["enter", "false"]);
        },
    );
});

describe("the core is code-representation agnostic", () => {
    // A minimal layer over plain-object nodes ({ kind, kids }) instead of
    // the Lisp IR: three node kinds, no calls, no opcode table. It exists
    // to prove the core really never touches a node shape -- everything
    // goes through the evalNode hook, and the generic machinery (seq via
    // seqStart, conditionals via OP_if_after and the boolify hooks) works
    // over any code type.
    type ObjNode = { kind: string; span?: string; ch: ObjNode[] };
    class ObjVM extends JebVM<any, string, ObjNode> {
        noneValue() {
            return null;
        }
        noValue() {
            return NO_VALUE;
        }
        createError(message: string) {
            return new JEBError(message, {}, {}, this.tracebackArray());
        }
        isError(value: unknown) {
            return value instanceof JEBError;
        }
        getLocation(node: ObjNode) {
            return node.span;
        }
        boolify(value: any) {
            pushData(this, value);
        }
        isTruthy(value: any) {
            return !!value;
        }
        booleanValue(value: boolean) {
            return value;
        }
        getVariable(): any {
            throw this.createError("no variables in this layer");
        }
        defineVariable(): void {
            throw this.createError("no variables in this layer");
        }
        assignVariable(): void {
            throw this.createError("no variables in this layer");
        }
        dispatchCall() {
            throw this.createError("no calls in this layer");
        }
        evalNode(node: ObjNode, tail: boolean) {
            switch (node.kind) {
                case "const":
                    pushData(this, node.ch[0]);
                    return;
                case "seq":
                    seqStart(this, node.ch as ObjNode[], tail);
                    return;
                case "if":
                    pushCommand(
                        this,
                        OP_if_after,
                        node.ch[1] as ObjNode,
                        node.ch[2] as ObjNode,
                        node.ch.length > 2,
                        tail,
                    );
                    pushCommand(this, OP_eval, node.ch[0] as ObjNode, false);
                    return;
                default:
                    throw this.createError(`unknown node kind: ${node.kind}`);
            }
        }
    }
    const K = (value: any): ObjNode => ({ kind: "const", ch: [value] });
    test("a VM over object nodes runs seq and if with no IR anywhere", () => {
        const vm = new ObjVM();
        const program: ObjNode = {
            kind: "seq",
            ch: [
                {
                    kind: "if",
                    ch: [K(true), K(1), K(2)],
                },
                K(42),
            ],
        };
        expect(run(vm, program)).toBe(42);
        const vm2 = new ObjVM();
        // a missing else produces the layer's None (null here)
        expect(
            run(vm2, { kind: "if", ch: [K(false), K(1)] }),
        ).toBe(null);
    });
});

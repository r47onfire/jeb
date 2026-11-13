import { describe, expect, test } from "bun:test";
import { Closure, codeLocation, JEBError, StackTreeNode } from "../src";
import {
    makeTestRun,
    NO_VALUE,
    run,
    runAsync,
    TestVM,
} from "../src/indextest";

// Programs are JEB's JSON code (see src/evaluate.ts): numbers, booleans,
// and null are literals; a bare string is a variable reference; an array
// is a call form whose head string names the callee; an object at the
// head of a call form is the call's location. String literals are
// written with quote.
const q = (text: string): any[] => ["quote", text];

const makeVM = () => {
    const vm = new TestVM();
    const out: string[] = [];
    vm.defineHostFunction("+", ["a", "b"], (_vm, a, b) => a + b);
    vm.defineHostFunction("-", ["a", "b"], (_vm, a, b) => a - b);
    vm.defineHostFunction("*", ["a", "b"], (_vm, a, b) => a * b);
    vm.defineHostFunction("=", ["a", "b"], (_vm, a, b) => a === b);
    vm.defineHostFunction("<", ["a", "b"], (_vm, a, b) => a < b);
    vm.defineHostFunction("print", ["...args"], (_vm, args) => {
        out.push((args as any[]).map(String).join(" "));
        return NO_VALUE;
    });
    vm.defineHostFunction("boom", [], (vm) => {
        throw vm.createError("boom");
    });
    return { vm, out };
};

const leafNames = (nodes: StackTreeNode[] | undefined): string[] =>
    (nodes ?? []).flatMap((node) =>
        node.leaf ? [String(node.name)] : leafNames(node.children),
    );

const leaves = (err: any): any[] =>
    (err.traceback as StackTreeNode[]).filter((node) => node.leaf);

describe("the JSON code model", () => {
    test("numbers, booleans, and null evaluate to themselves", () => {
        const { vm } = makeVM();
        expect(run(vm, 42)).toBe(42);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, true)).toBe(true);
        const { vm: vm3 } = makeVM();
        expect(run(vm3, null)).toBe(null);
    });
    test("a string evaluates to the variable of that name", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin", ["define", "x", 10], "x"])).toBe(10);
    });
    test("quote produces a string as data, not a variable reference", () => {
        const { vm } = makeVM();
        expect(run(vm, q("hello"))).toBe("hello");
    });
    test("quote produces arrays as data, unevaluated", () => {
        const { vm } = makeVM();
        // the form would throw if it were ever evaluated as code
        expect(run(vm, ["quote", ["boom"]])).toEqual(["boom"]);
    });
    test("a bare object is not valid code", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, { at: "here" } as any);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe(
            "objects are only valid as the location head of a call form",
        );
    });
    test("a lone location object is not a call", () => {
        const { vm } = makeVM();
        expect(() => run(vm, [{ at: "here" }])).toThrow(JEBError);
    });
    test("an empty array is not a call", () => {
        const { vm } = makeVM();
        expect(() => run(vm, [])).toThrow(JEBError);
    });
    test("codeLocation reads a call form's location head", () => {
        expect(codeLocation([{ at: 1 }, "f"])).toEqual({ span: { at: 1 } });
        expect(codeLocation(["f"])).toBeUndefined();
        expect(codeLocation(42)).toBeUndefined();
    });
});

describe("begin, comment, and no value", () => {
    test("begin returns its last value", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin", 1, 2, 3])).toBe(3);
    });
    test("an empty begin is none", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin"])).toBe(vm.noneValue());
    });
    test("a begin of only comments is none", () => {
        const { vm } = makeVM();
        expect(
            run(vm, ["begin", ["comment", "a"], ["comment", "b"]]),
        ).toBe(null);
    });
    test("comment evaluates nothing and produces no value", () => {
        const { vm } = makeVM();
        // the argument would throw if it were ever evaluated
        expect(run(vm, ["comment", ["boom"]])).toBe(vm.noValue());
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["comment", ["no-such-function", 1]])).toBe(
            vm2.noValue(),
        );
    });
    test("a trailing comment does not clobber a begin's value", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin", 42, ["comment", "note"]])).toBe(42);
    });
    test("define is an expression: it produces the value", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin", ["define", "x", 1], 5])).toBe(5);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["define", "x", 1])).toBe(1);
    });
});

describe("variables and let", () => {
    test("define then read", () => {
        const { vm } = makeVM();
        expect(run(vm, ["begin", ["define", "x", 10], "x"])).toBe(10);
    });
    test("assign updates an existing variable", () => {
        const { vm } = makeVM();
        expect(
            run(vm, ["begin", ["define", "x", 1], ["assign", "x", 2], "x"]),
        ).toBe(2);
    });
    test("assign to an undefined variable is an error", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, ["assign", "nope", 1]);
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
        expect(() => run(vm, "nope")).toThrow(JEBError);
    });
    test("let binds in a child scope and leaves the outer scope alone", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                ["begin", ["define", "x", 1], ["let", [["x", 2]], "x"]],
            ),
        ).toBe(2);
        const { vm: vm2 } = makeVM();
        expect(
            run(
                vm2,
                [
                    "begin",
                    ["define", "x", 1],
                    ["let", [["x", 2]], 0],
                    "x",
                ],
            ),
        ).toBe(1);
    });
    test("let binding values are evaluated in the outer scope", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    "begin",
                    ["define", "x", 10],
                    ["let", [["y", ["+", "x", 1]]], "y"],
                ],
            ),
        ).toBe(11);
        // a binding cannot see its siblings
        const { vm: vm2 } = makeVM();
        expect(() =>
            run(vm2, ["let", [["a", 1], ["b", "a"]], "b"]),
        ).toThrow(JEBError);
    });
});

describe("functions", () => {
    test("lambda and call", () => {
        const { vm } = makeVM();
        expect(
            run(vm, [["lambda", ["a", "b"], ["+", "a", "b"]], 3, 4]),
        ).toBe(7);
    });
    test("a lambda's value is a closure wrapping its body and environment", () => {
        const { vm } = makeVM();
        const result = run(vm, ["lambda", ["a"], "a"]);
        expect(result).toBeInstanceOf(Closure);
        expect(result.signature.params.map((p: any) => p.name)).toEqual(["a"]);
        expect(result.signature.rest).toBeUndefined();
        expect(result.body).toHaveLength(1);
    });
    test("closures capture their defining environment", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "make-adder",
                        [
                            "lambda",
                            ["x"],
                            ["lambda", ["y"], ["+", "x", "y"]],
                        ],
                    ],
                    ["let", [["add2", ["make-adder", 2]]], ["add2", 3]],
                ],
            ),
        ).toBe(5);
    });
    test("recursion through a defined name", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "fact",
                        [
                            "lambda",
                            ["k"],
                            [
                                "if",
                                ["<", "k", 2],
                                1,
                                ["*", "k", ["fact", ["-", "k", 1]]],
                            ],
                        ],
                    ],
                    ["fact", 5],
                ],
            ),
        ).toBe(120);
    });
    test("deep tail recursion does not grow the JS stack", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "count",
                        [
                            "lambda",
                            ["k"],
                            [
                                "if",
                                ["=", "k", 0],
                                0,
                                ["count", ["-", "k", 1]],
                            ],
                        ],
                    ],
                    ["count", 20000],
                ],
            ),
        ).toBe(0);
    });
    test("rest parameters collect the remaining arguments", () => {
        const { vm } = makeVM();
        expect(
            run(vm, [["lambda", ["first", "...rest"], "rest"], 1, 2, 3]),
        ).toEqual([2, 3]);
    });
    test("arity is checked", () => {
        const { vm } = makeVM();
        expect(() => run(vm, [["lambda", ["a"], "a"]])).toThrow(JEBError);
        const { vm: vm2 } = makeVM();
        expect(() => run(vm2, [["lambda", ["a"], "a"], 1, 2])).toThrow(
            JEBError,
        );
    });
    test("calling a non-callable is an error, before its arguments evaluate", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            // the argument would throw if it were ever evaluated
            run(vm, [42, ["boom"]]);
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
                [
                    "begin",
                    [
                        "define",
                        "f",
                        ["lambda", [], 99, ["comment", "note"]],
                    ],
                    ["f"],
                ],
            ),
        ).toBe(99);
    });
    test("a host function returning NO_VALUE does not clobber a begin", () => {
        const { vm, out } = makeVM();
        expect(run(vm, ["begin", 1, ["print", q("hi")], 2])).toBe(2);
        expect(out).toEqual(["hi"]);
    });
    test("an async host function's result is awaited", async () => {
        const { vm } = makeVM();
        vm.defineHostFunction("later", [], async () => 5);
        expect(await runAsync(vm, ["+", ["later"], 1])).toBe(6);
    });
    test("arguments evaluate in the call site's environment", () => {
        const { vm } = makeVM();
        // `z` exists only in the let's environment (the call site); the
        // closure was defined at the top level, where there is no `z`
        expect(
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "add",
                        ["lambda", ["a", "b"], ["+", "a", "b"]],
                    ],
                    ["let", [["z", 10]], ["add", "z", 5]],
                ],
            ),
        ).toBe(15);
    });
    test("tracebacks name the call chain with its location spans", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "f",
                        ["lambda", [], [{ at: "inner" }, "boom"]],
                    ],
                    [{ at: "outer" }, "f"],
                ],
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(leafNames(err.traceback)).toEqual(["boom", "f"]);
        const ls = leaves(err);
        expect(ls[0]!.leaf && ls[0]!.source?.span).toEqual({ at: "inner" });
        expect(ls[1]!.leaf && ls[1]!.source?.span).toEqual({ at: "outer" });
    });
});

describe("if", () => {
    test("branches on host truthiness", () => {
        const { vm } = makeVM();
        expect(run(vm, ["if", true, 1, 2])).toBe(1);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["if", 0, 1, 2])).toBe(2);
    });
    test("a missing else produces none, and the untaken branch is skipped", () => {
        const { vm } = makeVM();
        expect(run(vm, ["if", false, ["boom"]])).toBe(vm.noneValue());
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["if", true, 1, ["boom"]])).toBe(1);
    });
});

describe("lazy parameters and macro results", () => {
    test("a lazy parameter receives its argument form unevaluated", () => {
        const { vm } = makeVM();
        // (define quote (lambda (`x) x)) -- the user's example: with the
        // parameter backticked, the "macro" is an ordinary definition
        expect(
            run(
                vm,
                [
                    "begin",
                    ["define", "my-quote", ["lambda", ["`x"], "x"]],
                    ["my-quote", ["boom"]],
                ],
            ),
        ).toEqual(["boom"]);
    });
    test("a result is just a value unless set_macro_result is called", () => {
        const { vm } = makeVM();
        // the returned array is data; evaluated as code it would try to
        // call 1 as a function
        expect(
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "pair",
                        ["lambda", ["`x"], ["list", 1, 2]],
                    ],
                    ["pair", 0],
                ],
            ),
        ).toEqual([1, 2]);
    });
    test("set_macro_result re-evaluates the result as code in the caller's environment", () => {
        const { vm } = makeVM();
        const defineIncr = [
            "define",
            "incr",
            [
                "lambda",
                ["`x"],
                ["set_macro_result", true],
                ["list", q("+"), "x", 1],
            ],
        ];
        expect(run(vm, ["begin", defineIncr, ["incr", 5]])).toBe(6);
        const { vm: vm2 } = makeVM();
        expect(
            run(
                vm2,
                ["begin", ["define", "y", 10], defineIncr, ["incr", "y"]],
            ),
        ).toBe(11);
    });
    test("macro-ness is a runtime decision, not a property of the function", () => {
        const { vm } = makeVM();
        // = an ordinary function with an
        // evaluated parameter that flags its result for re-evaluation,
        // so calling it on quoted code evaluates the code
        const defineForce = [
            "define",
            "force",
            ["lambda", ["x"], ["set_macro_result", true], "x"],
        ];
        expect(
            run(vm, ["begin", defineForce, ["force", ["quote", ["+", 1, 2]]]]),
        ).toBe(3);
        const { vm: vm2 } = makeVM();
        expect(
            run(vm2, ["begin", defineForce, ["force", ["quote", 42]]]),
        ).toBe(42);
    });
    test("when runs its body only if the test is truthy", () => {
        const { vm } = makeVM();
        expect(run(vm, ["when", true, 1, 2])).toBe(2);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["when", false, ["boom"]])).toBe(null);
    });
    test("unless runs its body only if the test is falsy", () => {
        const { vm } = makeVM();
        expect(run(vm, ["unless", false, 7])).toBe(7);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["unless", true, ["boom"]])).toBe(null);
    });
    test("eval evaluates code produced at runtime", () => {
        const { vm } = makeVM();
        expect(run(vm, ["eval", ["quote", ["+", 1, 2]]])).toBe(3);
    });
    test("eval of a bare object is an error", () => {
        const { vm } = makeVM();
        expect(() => run(vm, ["eval", ["quote", { at: "x" }]])).toThrow(
            JEBError,
        );
    });
});

describe("signatures", () => {
    test("a default supplies a missing argument, and is overridden by a given one", () => {
        const { vm } = makeVM();
        expect(run(vm, [["lambda", [["a", 10]], "a"]])).toBe(10);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, [["lambda", [["a", 10]], "a"], 3])).toBe(3);
    });
    test("an evaluated default is a form, evaluated in the call-site environment", () => {
        const { vm } = makeVM();
        expect(run(vm, [["lambda", [["a", ["+", 1, 2]]], "a"]])).toBe(3);
        const { vm: vm2 } = makeVM();
        // the default names a variable that only exists at the call site
        expect(
            run(vm2, ["let", [["x", 7]], [["lambda", [["a", "x"]], "a"]]]),
        ).toBe(7);
    });
    test("a lazy default is the form itself, like a passed lazy argument", () => {
        const { vm } = makeVM();
        expect(run(vm, [["lambda", [["`x", q("dflt")]], "x"]])).toEqual(
            q("dflt"),
        );
    });
    test("host functions get the same checking: arity is enforced", () => {
        const { vm } = makeVM();
        expect(() => run(vm, ["+", 1])).toThrow(JEBError);
        const { vm: vm2 } = makeVM();
        expect(() => run(vm2, ["+", 1, 2, 3])).toThrow(JEBError);
    });
    test("host rest parameters arrive bundled as one array", () => {
        const { vm } = makeVM();
        vm.defineHostFunction("collect", ["...xs"], (_vm, xs) => xs);
        expect(run(vm, ["collect", 1, 2, 3])).toEqual([1, 2, 3]);
    });
    test("host lazy parameters receive raw forms", () => {
        const { vm } = makeVM();
        vm.defineHostFunction("rawarg", ["`x"], (_vm, x) => x);
        // the argument would throw if it were ever evaluated
        expect(run(vm, ["rawarg", ["boom"]])).toEqual(["boom"]);
    });
    test("host defaults work like closure defaults", () => {
        const { vm } = makeVM();
        vm.defineHostFunction("greet", [["name", q("world")]], (_vm, name) => name);
        expect(run(vm, ["greet"])).toBe("world");
        expect(run(vm, ["greet", q("mars")])).toBe("mars");
    });
});

describe("named let", () => {
    const loop = [
        "let",
        "loop",
        [
            ["n", 5],
            ["acc", 0],
        ],
        ["if", ["=", "n", 0], "acc", ["loop", ["-", "n", 1], ["+", "acc", "n"]]],
    ];
    test("the loop name re-enters the body with new values", () => {
        const { vm } = makeVM();
        expect(run(vm, loop)).toBe(15);
    });
    test("each iteration reports a jeb:loop_check audit event with its counter", () => {
        const { vm } = makeVM();
        const seen: number[] = [];
        vm.on("jeb:loop_check", (n) => seen.push(n));
        expect(run(vm, loop)).toBe(15);
        expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    });
});

describe("the standard library", () => {
    test("uncomment splices its forms back into a begin", () => {
        const { vm } = makeVM();
        expect(
            run(vm, ["uncomment", ["define", "x", 1], "x"]),
        ).toBe(1);
    });
    test("cwcc hands the callee the current continuation", () => {
        const { vm } = makeVM();
        expect(run(vm, ["cwcc", ["lambda", ["k"], ["k", 42]]])).toBe(42);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["cwcc", ["lambda", ["k"], 7]])).toBe(7);
    });
    test("while loops until its condition is falsy", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    "begin",
                    ["define", "i", 0],
                    ["while", ["<", "i", 3], ["assign", "i", ["+", "i", 1]]],
                    "i",
                ],
            ),
        ).toBe(3);
    });
    test("zero?, reduce, and map", () => {
        const { vm } = makeVM();
        expect(run(vm, ["zero?", 0])).toBe(true);
        const { vm: vm2 } = makeVM();
        expect(run(vm2, ["zero?", 5])).toBe(false);
        const { vm: vm3 } = makeVM();
        expect(
            run(
                vm3,
                [
                    "reduce",
                    ["list", 1, 2, 3],
                    ["lambda", ["a", "b"], ["+", "a", "b"]],
                    0,
                ],
            ),
        ).toBe(6);
        const { vm: vm4 } = makeVM();
        expect(
            run(
                vm4,
                [
                    "map",
                    ["list", 1, 2, 3],
                    ["lambda", ["x"], ["*", "x", 2]],
                ],
            ),
        ).toEqual([2, 4, 6]);
    });
    test("|> pipes a value through steps with % bound", () => {
        const { vm } = makeVM();
        expect(
            run(vm, ["|>", 5, ["+", "%", 1], ["*", "%", 2]]),
        ).toBe(12);
    });
});

describe("value hooks", () => {
    test("number literals pass through the layer's wrapNumber hook", () => {
        class BoxedVM extends TestVM {
            override wrapNumber(value: number) {
                return ["num", value];
            }
        }
        const vm = new BoxedVM();
        expect(run(vm, 42)).toEqual(["num", 42]);
        // null is the none value, not a wrapped number
        expect(run(vm, null)).toBe(null);
    });
    test("undefined is not valid code", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(vm, undefined as any);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("undefined is not valid code");
    });
});

describe("return", () => {
    test("a function that never calls return returns its body's value", () => {
        const { vm } = makeVM();
        expect(run(vm, [["lambda", [], 7]])).toBe(7);
    });
    test("return abandons the rest of the body", () => {
        const { vm } = makeVM();
        expect(
            run(vm, [["lambda", [], ["begin", ["return", 1], 2]]]),
        ).toBe(1);
    });
    test("return exits only its own function", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    ["lambda", [], ["+", 1, [["lambda", [], ["return", 10]]]]],
                ],
            ),
        ).toBe(11);
    });
    test("a captured return escapes the enclosing function from an inner one", () => {
        const { vm } = makeVM();
        expect(
            run(
                vm,
                [
                    [
                        "lambda",
                        [],
                        [
                            "let",
                            [["r", "return"]],
                            ["+", 1, [["lambda", [], ["r", 42]]]],
                        ],
                    ],
                ],
            ),
        ).toBe(42);
    });
});

describe("dynamic-wind", () => {
    const thunk = (label: string): any[] => [
        "lambda",
        [],
        ["print", q(label)],
    ];
    // enter handlers take an isFromContinuation flag; exit handlers take
    // the error (or null) and the same flag
    const enter = (): any[] => ["lambda", ["cont"], ["print", q("enter")]];
    const exit = (): any[] => [
        "lambda",
        ["err", "cont"],
        ["print", q("exit")],
    ];
    test("runs enter, body, and exit in order", () => {
        const { vm, out } = makeVM();
        run(vm, ["dynamic_wind", enter(), thunk("body"), exit()]);
        expect(out).toEqual(["enter", "body", "exit"]);
    });
    test("escaping through a wind still runs its exit handler", () => {
        const { vm, out } = makeVM();
        const result = run(
            vm,
            [
                [
                    "lambda",
                    [],
                    [
                        "let",
                        [["r", "return"]],
                        [
                            "dynamic_wind",
                            enter(),
                            ["lambda", [], ["r", q("escaped")]],
                            exit(),
                        ],
                    ],
                ],
            ],
        );
        expect(result).toBe("escaped");
        expect(out).toEqual(["enter", "exit"]);
    });
    test("throw runs exit handlers with the error", () => {
        const { vm, out } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "dynamic_wind",
                    ["lambda", ["cont"], null],
                    ["lambda", [], ["throw", q("bad")]],
                    exit(),
                ],
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
    const noEnter = (): any[] => ["lambda", ["cont"], null];
    test("an exit handler can cancel error propagation by returning true", () => {
        const { vm } = makeVM();
        const result = run(
            vm,
            [
                "begin",
                ["define", "seen", null],
                [
                    "dynamic_wind",
                    noEnter(),
                    ["lambda", [], ["boom"]],
                    [
                        "lambda",
                        ["err", "cont"],
                        ["begin", ["assign", "seen", "err"], true],
                    ],
                ],
                42,
            ],
        );
        // execution continued past the dynamic_wind, and no error is parked
        expect(result).toBe(42);
        expect(vm.error).toBeUndefined();
        // ...and the exit handler was called with the error
        const seen = run(vm, "seen");
        expect(seen).toBeInstanceOf(JEBError);
        expect((seen as JEBError).message).toBe("boom");
    });
    test("an exit handler returning anything else lets the error propagate", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "dynamic_wind",
                    noEnter(),
                    ["lambda", [], ["boom"]],
                    ["lambda", ["err", "cont"], false],
                ],
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
            [
                "dynamic_wind",
                noEnter(),
                [
                    "lambda",
                    [],
                    [
                        "dynamic_wind",
                        noEnter(),
                        ["lambda", [], ["boom"]],
                        [
                            "lambda",
                            ["err", "cont"],
                            ["begin", ["print", q("inner")], true],
                        ],
                    ],
                ],
                ["lambda", ["err", "cont"], ["print", "err"]],
            ],
        );
        expect(vm.error).toBeUndefined();
        // the inner handler caught the error; the outer wind then exited
        // normally, so its exit handler ran with null, not the error
        expect(out).toEqual(["inner", "null"]);
    });
    test("a dynamic_wind whose exit handler cancels produces none", () => {
        const { vm } = makeVM();
        const result = run(
            vm,
            [
                "begin",
                7,
                [
                    "dynamic_wind",
                    noEnter(),
                    ["lambda", [], ["boom"]],
                    ["lambda", ["err", "cont"], true],
                ],
            ],
        );
        expect(result).toBe(vm.noneValue());
    });
    test("try/catch is buildable from dynamic_wind plus cancellation", () => {
        const { vm } = makeVM();
        // (try body) evaluates to the body's value, or to "caught" if the
        // body threw: the exit handler stashes the error in `caught` and
        // returns true to cancel it, and the code after the wind decides.
        const try_ = (body: any): any[] => [
            "begin",
            ["define", "caught", null],
            ["define", "result", null],
            [
                "dynamic_wind",
                noEnter(),
                ["lambda", [], ["assign", "result", body]],
                [
                    "lambda",
                    ["err", "cont"],
                    [
                        "if",
                        "err",
                        ["begin", ["assign", "caught", "err"], true],
                        false,
                    ],
                ],
            ],
            ["if", "caught", q("caught"), "result"],
        ];
        expect(run(vm, try_(["+", 1, 2]))).toBe(3);
        expect(run(vm, try_(["boom"]))).toBe("caught");
    });
});

describe("span injection", () => {
    test("hide_call hides the invoking call's traceback entry", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "f",
                        [
                            "lambda",
                            [],
                            ["begin", ["hide_call", true], ["boom"]],
                        ],
                    ],
                    ["f"],
                ],
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        // f's entry is hidden; only boom's remains
        expect(leafNames(err.traceback)).toEqual(["boom"]);
    });
    test("redirect_call moves the invoking call's entry to an argument's location", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "g",
                        [
                            "lambda",
                            ["x"],
                            ["redirect_call", 0],
                            [{ at: "boomcall" }, "boom"],
                        ],
                    ],
                    ["g", [{ at: "argloc" }, "+", 1, 2]],
                ],
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(leafNames(err.traceback)).toEqual(["boom", "g"]);
        const ls = leaves(err);
        expect(ls[1]!.leaf && ls[1]!.source?.span).toEqual({ at: "argloc" });
    });
    test("throw_runtime_error with a parameter blames that argument's location", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "h",
                        [
                            "lambda",
                            ["x"],
                            ["throw_runtime_error", 0, q("bad arg")],
                        ],
                    ],
                    ["h", [{ at: "blame" }, "+", 1, 2]],
                ],
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("bad arg");
        // throw_runtime_error's own entry is gone; h's entry moved to the
        // argument's location
        expect(leafNames(err.traceback)).toEqual(["h"]);
        const ls = leaves(err);
        expect(ls[0]!.leaf && ls[0]!.source?.span).toEqual({ at: "blame" });
    });
    test("throw_runtime_error with null blames the invoking call itself", () => {
        const { vm } = makeVM();
        let err: any;
        try {
            run(
                vm,
                [
                    "begin",
                    [
                        "define",
                        "h",
                        [
                            "lambda",
                            ["x"],
                            ["throw_runtime_error", null, q("oops")],
                        ],
                    ],
                    [{ at: "callsite" }, "h", 1],
                ],
            );
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(JEBError);
        expect(err.message).toBe("oops");
        expect(leafNames(err.traceback)).toEqual(["h"]);
        const ls = leaves(err);
        expect(ls[0]!.leaf && ls[0]!.source?.span).toEqual({
            at: "callsite",
        });
    });
});

const testWind = makeTestRun(makeVM);

describe("dynamic-wind handler flags", () => {
    const enter = (): any[] => [
        "lambda",
        ["cont"],
        ["if", "cont", ["print", q("enter-cont")], ["print", q("enter")]],
    ];
    const exit = (): any[] => [
        "lambda",
        ["err", "cont"],
        ["print", "err", "cont"],
    ];
    testWind(
        test,
        "a normal pass calls enter and exit with isFromContinuation false",
        (vm, out) => {
            run(
                vm,
                ["dynamic_wind", enter(), ["lambda", [], ["print", q("body")]], exit()],
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
                [
                    [
                        "lambda",
                        [],
                        [
                            "let",
                            [["r", "return"]],
                            [
                                "dynamic_wind",
                                enter(),
                                ["lambda", [], ["r", q("escaped")]],
                                exit(),
                            ],
                        ],
                    ],
                ],
            );
            expect(result).toBe("escaped");
            expect(out).toEqual(["enter", "null true"]);
        },
    );
    testWind(
        test,
        "re-entering through a continuation calls enter with isFromContinuation true",
        (vm, out) => {
            // the body captures a continuation standing for "the rest of
            // the body, then out of the wind" (an inner function's return)
            // and stores it; invoking it after the wind has exited
            // re-enters the wind
            const result = run(
                vm,
                [
                    "begin",
                    ["define", "k", null],
                    ["define", "first", true],
                    [
                        "dynamic_wind",
                        enter(),
                        [
                            "lambda",
                            [],
                            [
                                "begin",
                                [["lambda", [], ["assign", "k", "return"]]],
                                ["print", q("body")],
                            ],
                        ],
                        exit(),
                    ],
                    [
                        "if",
                        "first",
                        ["begin", ["assign", "first", false], ["k", null]],
                        q("done"),
                    ],
                ],
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
                    [
                        "dynamic_wind",
                        enter(),
                        ["lambda", [], ["boom"]],
                        ["lambda", ["err", "cont"], ["print", "cont"]],
                    ],
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

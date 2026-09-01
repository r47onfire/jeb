import { describe, expect, test } from "bun:test";
import { parse, stringify } from "lib0/json";
import { float, int, JEBError, JebVM, makeSingleEventWatcher, OP_shuffle, popData, pushCommand, pushData, typeMatches } from "../src";
import { makeTestRun, rawTraceback, run } from "../src/indextest";

const testTest = makeTestRun(JebVM);

describe("type matching test", () => {
    test("subclass score", () => {
        class A { }
        class B extends A { }
        class C extends B { }
        expect(typeMatches(new C(), A)).toBeLessThan(typeMatches(new C(), B));
        expect(typeMatches(new C(), A)).toBeLessThan(typeMatches(new C(), C));
        expect(typeMatches(new C(), B)).toBeLessThan(typeMatches(new C(), C));
    });
});

describe("stack machine test", () => {
    testTest(test, "identity", vm => {
        pushData(vm, 1);
        pushData(vm, 2);
        pushData(vm, 3);
        pushData(vm, 4);
        pushData(vm, 5);
        pushCommand(vm, OP_shuffle, 5, [0, 1, 2, 3, 4]);
        vm.step();
        expect(popData(vm)).toEqual(5);
        expect(popData(vm)).toEqual(4);
        expect(popData(vm)).toEqual(3);
        expect(popData(vm)).toEqual(2);
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "tuck", vm => {
        pushData(vm, 1);
        pushData(vm, 2);
        pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
        vm.step();
        expect(popData(vm)).toEqual(2);
        expect(popData(vm)).toEqual(1);
        expect(popData(vm)).toEqual(2);
    });
});

describe("basic", () => {
    testTest(test, "begin with no args returns null", vm => {
        expect(run(vm, ["begin"])).toBeTrue();
        expect(popData(vm)).toBeNull();
    });
    describe("undefined", () => {
        testTest(test, "getting variable", vm => {
            expect(() => run(vm, ["$", "nonexistent"])).toThrow('variable "nonexistent" not found');
        });
        testTest(test, "setting variable", vm => {
            expect(() => run(vm, ["set", ["$", "nonexistent"], 1])).toThrow('variable "nonexistent" not found');
        });
        testTest(test, "function", vm => {
            expect(() => run(vm, ["nonexistent"])).toThrow('function "nonexistent" not found');
        });
    });
    testTest(test, "basic commands", (vm, out) => {
        expect(run(vm, ["begin", ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest(test, "basic commands wrapped in fn", (vm, out) => {
        expect(run(vm, [["fn", [], ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest(test, "get complex value", vm => {
        expect(run(vm, ["begin",
            ["define", ["x"], ["list", ["list", 1], ["list", 2], ["list", 4]]],
            [".", [".", ["x"], 1], 0],
        ])).toBeTrue();
        expect(popData(vm)).toBe(2);
    });
    testTest(test, "set with existing value", (vm, out) => {
        expect(run(vm, ["begin",
            ["let-in", "x", 0],
            ["print", ["set", ["$", "x"], 10]],
            ["print", ["$", "x"]],
            ["print", ["set", ["$", "x"], ["+", 1, ["$", "_"]]]],
            ["print", ["$", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "10", "11", "11"]);
    });
    testTest(test, "get with computed indexing", vm => {
        expect(run(vm, ["begin",
            ["let-in", "x", ["list", 1, 2, 3]],
            [".", ["$", "x"], [".", ["$", "x"], 0]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "set with old value", (vm, out) => {
        expect(run(vm, ["begin",
            ["let-in", "x", 0],
            ["print", ["set", ["$", "x"], 10, true]],
            ["print", ["$", "x"]],
            ["print", ["set", ["$", "x"], ["+", 1, ["$", "_"]], true]],
            ["print", ["$", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["0", "10", "10", "11"]);
    });
    testTest(test, "set complex value lvalue is only evaluated once", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "value", { x: 1 }],
            ["define", ["f"], ["print", "called"], ["$", "value"]],
            ["set", [".", ["f"], "x"], ["+", 10, ["$", "_"]]],
            ["$", "value"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ x: 11 });
        expect(out).toEqual(["called"]);
    });
    testTest(test, "calling non-functions errors", vm => {
        expect(() => run(vm, [1, 2, 3])).toThrow("can't call number");
    });
    testTest(test, "math overload error", vm => {
        expect(() => run(vm, ["+", "hi", 1])).toThrow("No overload of add exists for types string, number")
    });
    testTest(test, "boolean short-circuiting", (vm, out) => {
        expect(run(vm, ["begin",
            ["or", true, ["print", "a"]],
            ["or", false, ["print", "b"]],
            ["and", 0, ["print", "a"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
        expect(out).toEqual(["b"]);
    });
    testTest(test, "json error 1", vm => {
        try {
            parse("[");
        } catch (error: any) {
            expect(() => run(vm, ["jsonparse", "["])).toThrow(error.message);
        }
    });
    testTest(test, "json error 2", vm => {
        try {
            const x: any = [];
            x[0] = x;
            stringify(x);
        } catch (error: any) {
            expect(() => run(vm, ["begin",
                ["let-in", "x", ["list"]],
                ["set", [".", ["$", "x"], 0], ["$", "x"]],
                ["jsonstringify", ["$", "x"]]
            ])).toThrow(error.message);
        }

    });
    testTest(test, "property chain get", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            [".", [".", [".", ["$", "x"], "a"], "b"], "foo"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
    testTest(test, "property chain set", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["set", [".", [".", [".", ["$", "x"], "a"], "b"], "foo"], ["+", ["$", "_"], 333]],
            ["$", "x"]
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ a: { b: { foo: 456 } } });
    });
});

describe("tail-call elimination", () => {
    testTest(test, "command stack stays constant", vm => {
        expect(run(vm, ["begin",
            ["define", ["loop"], ["loop"]],
            ["loop"]
        ], 5000)).toBeFalse();

        // with TCO the stack never grows beyond a handful of ops
        expect(vm.recursionDepth).toBeLessThan(10);
        // traceback is a single self-referential frame + top-level begin
        expect(rawTraceback(vm)).toEqual(["loop", "begin"]);
    });

    testTest(test, "tail frames are still dropped on return", (vm, out) => {
        expect.assertions(4);
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["bar"]],
                ["define", ["bar"], ["print", "hello"]],
                ["foo"],
                ["foo"],
                ["throw", ["err", "test"]]
            ]);
        } catch (err: any) {
            expect(out).toEqual(["hello", "hello"]);
            // foo and bar were tail-called, only begin and error survive
            expect(err.toString()).toContain("VM stack: err<-begin");
            expect(err.toString()).not.toContain("foo");
            expect(err.toString()).not.toContain("bar");
        }

    });

    testTest(test, "non-tail frames are kept", vm => {
        expect.assertions(1);
        try {
            run(vm, ["begin",
                ["define", ["f"], ["+", 1, ["g"]]],
                ["define", ["g"], ["throw", ["err", "foo"]]],
                ["f"]
            ]);
        } catch (err: any) {
            // f -> g is NOT a tail call (it's an argument), so both stay
            expect(err.toString()).toContain("VM stack: err<-g<-f<-begin");
        }
    });
});

describe("traceback compression", () => {
    testTest(test, "compresses long alternating cycle", vm => {
        expect.assertions(2);
        // a <-> b tail recursion
        expect(run(vm, ["begin",
            ["define", ["a"], ["b"]],
            ["define", ["b"], ["a"]],
            ["a"]
        ], 6000)).toBeFalse();

        // force an error to snapshot the stack
        vm.checkRecursion(0);
        try {
            while (vm.step());
        } catch (err: any) {
            // should be "(b<-a * N)" not a zillion repeats
            expect(err.toString()).toMatch(/\((b<-a|a<-b) \* \d+\)/);
        }
    });

    testTest(test, "nests cycles", vm => {
        expect.assertions(2);
        try {
            run(vm, ["begin",
                ["define", ["foo", "x"],
                    ["if", [">", ["$", "x"], 0],
                        ["bar", ["-", ["$", "x"], 1]],
                        ["baz"]],
                    ["unreachable"]],
                ["define", ["bar", "x"],
                    ["foo", ["$", "x"]]],
                ["define", ["baz"],
                    ["foo", 10]],
                ["baz"],
            ]);
        } catch (err: any) {
            expect(err.toString()).toMatch(/\(if<-foo<-bar \* \d+\)/);
            expect(err.toString()).toMatch(/\([^)]*\(/);
        }
    });
});


describe("with / dynamic-wind", () => {

    const makeWith = (begin: string, end: string, ...body: any[]) => {
        return ["with", null,
            {
                enter: ["fn", ["k"],
                    ["print", begin, ["$", "k"]]],
                exit: ["fn", ["k", "err"],
                    ["print",
                        end,
                        ["$", "k"],
                        ["$", "err"]]]
            },
            ...body
        ];
    }
    testTest(test, "runs before then body then after and returns body", (vm, out) => {
        expect(run(vm, makeWith("before", "after", ["print", "body"], 123))).toBeTrue();
        expect(popData(vm)).toEqual(123);
        expect(out).toEqual(["before false", "body", "after false null"]);
    });

    testTest(test, "after runs on error", (vm, out) => {
        expect.assertions(4);
        try {
            run(vm, makeWith("before", "after", ["throw", ["err", "boom", "test"]]));
        } catch (err: any) {
            expect(err).toBeDefined();
            expect(err.toString()).toContain("boom");
            expect(err.toString()).toContain("VM stack: err<-with");
            expect(out).toEqual(["before false", "after false (test) boom\nVM stack: err<-with"]);
        }
    });

    testTest(test, "nested with unwinds in stack order", (vm, out) => {
        expect(run(vm, makeWith("enter outer", "exit outer", makeWith("enter inner", "exit inner", null)))).toBeTrue();
        expect(out).toEqual(["enter outer false", "enter inner false", "exit inner false null", "exit outer false null"]);
    });

    testTest(test, "continuation re-enters with", (vm, out) => {
        expect(run(vm, ["begin",
            ["let-in", "k", null],
            makeWith("enter", "exit",
                [["fn", [], ["set", ["$", "k"], ["$", "return"]]]],
                ["print", "inside"]),
            ["print", "outside"],
            ["k", null],          // jump back into the with
            ["throw", ["err", "unreachable"]]
        ], 2000)).toBeFalse();

        const init = [
            "enter false",
        ];
        const repeated = [
            "inside",
            "exit false null",
            "outside",
            "enter true",
        ];
        for (var i = 0; init.length < out.length; i++, i %= repeated.length) {
            init.push(repeated[i]!);
        }
        expect(out).toEqual(init);
    });

    testTest(test, "continuation escapes with (after runs once)", (vm, out) => {
        // escape from inside with via a continuation captured outside
        expect(run(vm, ["begin",
            [["fn", [],
                makeWith("enter", "exit",
                    ["print", "inside"],
                    ["return", null],
                    ["throw", ["err", "unreachable"]])
            ]],
            ["print", "outside"]
        ])).toBeTrue();

        expect(out).toEqual(["enter false", "inside", "exit true null", "outside"]);
    });

    testTest(test, "uncaught errors retain full traceback", vm => {
        expect.assertions(1);
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["throw"]],
                makeWith("", "", makeWith("", "", makeWith("", "", ["foo"])))
            ]);
        } catch (err: any) {
            expect(err.toString()).toContain("foo<-(with * 3)");
        }
    });

    testTest(test, "with requires variable name or null", vm => {
        expect(() => run(vm, ["with", { enter: null, exit: null }, false])).toThrow('expected variable name or null as first argument to "with"')
    });
    testTest(test, "with requires context object", vm => {
        expect(() => run(vm, ["with", null, null, false])).toThrow("context manager should be an object")
    });

    testTest(test, "continuation can be called with computed value", vm => {
        expect(run(vm, ["begin",
            ["let-in", "x", null],
            ["let-in", "y", [["fn", ["f"], ["f", ["$", "return"]]], ["fn", ["k"], ["set", ["$", "x"], ["$", "k"]]]]],
            ["if", ["=", ["$", "y"], 123],
                null,
                ["x", ["+", 23, 100]]],
            ["$", "y"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
});

describe("metaprogramming", () => {
    testTest(test, "eval", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "x", ["'", ["print", ["$", "a"]]]],
            ["let", [["a", "hello"]], ["eval", ["$", "x"]]],
        ])).toBeTrue();
        expect(out).toEqual(["hello"]);
    });
    testTest(test, "user-defined macros", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["twice", [true, "x"]], ["macro", ["list", "+", ["$", "x"], ["$", "x"]]]],
            ["print", ["twice", 2]],
            ["print", ["twice", "hello"]],
            ["let", [["a", 4]], ["print", ["twice", ["begin", ["print", "arg evaluated"], ["$", "a"]]]]]
        ])).toBeTrue();
        expect(out).toEqual(["4", "hellohello", "arg evaluated", "arg evaluated", "8"]);
    });
    testTest(test, "quote/quasiquote", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "a", 1],
            ["define", "b", 2],
            ["define", "c", 3],
            ["define", "x", ["list", 4, 5, 6]],
            ["print", ["jsonstringify", ["'", ["foo", "bar", "baz"]]]],
            ["print", ["jsonstringify", ["~", ["foo", "bar", "baz"]]]],
            ["print", ["jsonstringify", ["~", ["foo", "bar", ["baz"]]]]],
            ["print", ["jsonstringify", ["~", ["foo", "bar", [",", ["$", "a"]]]]]],
            ["print", ["jsonstringify", ["'", ["foo", "bar", [",", ["$", "a"]]]]]],
            ["print", ["jsonstringify", ["~", ["foo", "bar", [",", ["$", "x"]]]]]],
            ["print", ["jsonstringify", ["~", ["foo", "bar", [",@", ["$", "x"]]]]]],
            ["let", [["y", ["list", 1, 2, 3]]], ["print", ["jsonstringify", ["~", ["foo", "bar", [",@", ["$", "y"]]]]]]],
        ])).toBeTrue();
        expect(out).toEqual([
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", ["baz"]]),
            stringify(["foo", "bar", 1]),
            stringify(["foo", "bar", [",", ["$", "a"]]]),
            stringify(["foo", "bar", [4, 5, 6]]),
            stringify(["foo", "bar", 4, 5, 6]),
            stringify(["foo", "bar", 1, 2, 3]),
        ]);
    });
    testTest(test, "bad unquote 1", vm => {
        expect(() => run(vm, ["~", [","]])).toThrow("expected 1 argument to unquote");
    });
    testTest(test, "bad unquote 2", vm => {
        expect(() => run(vm, [",", 1])).toThrow("unquote not valid outside of quasiquote");
    });
    testTest(test, "bad unquoteSplicing 1", vm => {
        try {
            // @ts-expect-error
            [...1];
        } catch (e) {
            expect(() => run(vm, ["~", [[",@", 1], 2]])).toThrow(String(e));
        }
    });
    testTest(test, "bad unquoteSplicing 2", vm => {
        expect(() => run(vm, ["~", [[",@"]]])).toThrow("expected 1 argument to unquoteSplicing");
    });
    testTest(test, "bad unquoteSplicing 3", vm => {
        expect(() => run(vm, ["~", [",@", 1]])).toThrow("unquoteSplicing outside of list");
    });
    testTest(test, "bad unquoteSplicing 4", vm => {
        expect(() => run(vm, [",@", 1])).toThrow("unquoteSplicing not valid outside of quasiquote");
    });
});

describe("keyword and splat arguments", () => {
    testTest(test, "kwargs ignore order", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonstringify", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["kw", "y", 2], ["kw", "x", 1]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "splat unpack into positional", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonstringify", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["splat", ["list", 1, 2]]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "kwarg unpack into named parameters", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonstringify", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["splat", { x: 1, y: 2 }, true]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "order enforced", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonstringify", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["kw", "x", 1], 2],
        ])).toThrow("positional argument can't follow keyword argument");
    });

    testTest(test, "missing arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y"]],
            ["foo", ["kw", "x", 1]],
        ])).toThrow('missing required parameter "y" of function "foo"');
    });

    testTest(test, "too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, 3, 4],
        ])).toThrow('too many arguments to function "foo" (expected at most 3)');
    });

    testTest(test, "unpacking too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, ["splat", ["list", 3, 4]]],
        ])).toThrow('too many elements in splat argument to function "foo" (at most 1 can be passed here)');
    });

    testTest(test, "unknown keyword arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x"]],
            ["foo", ["kw", "y", 1]],
        ])).toThrow('unexpected keyword argument "y" to function "foo"');
    });

    testTest(test, "unknown keyword arguments via unpack errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x"]],
            ["foo", ["splat", { y: 1 }, true]],
        ])).toThrow('unexpected splat keyword argument "y" to function "foo"');
    });
});

describe("fns", () => {
    testTest(test, "fn optional dynamic env", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["a", ["$", "x"]]], ["print", ["$", "a"]]],
            ["let", [["x", "hello"]], ["foo"], ["foo", "goodbye"]],
        ])).toBeTrue();
        expect(out).toEqual(["hello", "goodbye"]);
    });
    testTest(test, "fn validation", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", ["a", 1, 2, 3]], ["print", ["$", "a"]]],
        ])).toThrow("unexpected junk after default expression");
    });
    testTest(test, "spread arguments", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", "x", true], ["print", ["jsonstringify", ["$", "x"]]]],
            ["foo", 1, 2, 3],
            ["foo"]
        ])).toBeTrue();
        expect(out).toEqual(["[1,2,3]", "[]"]);
    });
    testTest(test, "required must follow optional", vm => {
        expect(() => run(vm, ["define", ["foo", ["x", 1], "y"], false])).toThrow('required parameter "y" cannot follow optional parameter');
    });
    testTest(test, "bad params", vm => {
        expect(() => run(vm, ["define", ["foo", 1], false])).toThrow("arg name not found at position 0");
    });
    testTest(test, "let loop", (vm, out) => {
        expect(run(vm, ["begin",
            ["let", "loop", [["x", 10]],
                ["print", ["$", "x"]],
                ["if", [">", ["$", "x"], 0],
                    ["loop", ["-", ["$", "x"], 1]]]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    });
    testTest(test, "bad define", vm => {
        expect(() => run(vm, ["define", 1])).toThrow("invalid define syntax")
    });
});

describe("recursion stress tests", () => {
    testTest(test, "A000142 (factorial)", vm => {
        const x = 5000n;
        const factorial = (a: bigint): bigint => a > 1 ? a * factorial(a - 1n) : 1n;
        expect(run(vm, ["begin",
            ["define", ["factorial", "a"],
                ["if", [">", ["$", "a"], 1],
                    ["*", ["factorial", ["-", ["$", "a"], 1n]], ["$", "a"]],
                    1n]],
            ["factorial", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(factorial(x));
    });
    const MEMOIZE_F = (f: (a: bigint) => bigint) => { const cache: Record<number, bigint> = {}; return (a: bigint) => (cache[a as any] ??= f(a)) }
    const MEMOIZE = ["define", ["memoize", "f"],
        ["let", [["cache", {}]],
            ["fn", ["a"],
                ["let", [["cached", [".", ["$", "cache"], ["$", "a"]]]],
                    ["if", ["nil?", ["$", "cached"]],
                        ["set", [".", ["$", "cache"], ["$", "a"]], ["f", ["$", "a"]]],
                        ["$", "cached"]]]]]
    ];
    const fibonacci = MEMOIZE_F(a => a < 2 ? a : fibonacci(a - 1n) + fibonacci(a - 2n));
    const q = MEMOIZE_F(a => a < 3 ? 1n : q(a - q(a - 1n)) + q(a - q(a - 2n)));
    const A063510 = (a: number): number => a < 2 ? 1 : 1 + A063510(a ** 0.5 | 0);
    testTest(test, "A000045 (Fibonacci sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "fibonacci", ["memoize", ["fn", ["a"],
                ["if", ["<", ["$", "a"], 2],
                    ["$", "a"],
                    ["+",
                        ["fibonacci", ["-", ["$", "a"], 1]],
                        ["fibonacci", ["-", ["$", "a"], 2]]]]]]],
            ["fibonacci", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(fibonacci(x));
    });
    testTest(test, "A005185 (Hofstadter 'Q' sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "q", ["memoize", ["fn", ["a"],
                ["if", ["<", ["$", "a"], 3],
                    1,
                    ["+",
                        ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 1]]]],
                        ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 2]]]]]]]]],
            ["q", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(Number(q(x)));
    });
    testTest(test, "A063510", vm => {
        const x = 1e20;
        expect(run(vm, ["begin",
            ["define", ["A063510", "a"],
                ["if", ["<", ["$", "a"], 2],
                    1,
                    ["+", 1, ["A063510", ["bit-or", 0, ["pow", ["$", "a"], 0.5]]]]]],
            ["A063510", x],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(A063510(x));
    });
    describe("unlambda", () => {
        const unlambda = (name: string, program: string, expectedOutput: string, autostop = false) => {
            testTest(test, name, vm => {
                var i = 0;
                var out: string = "";
                const next = () => program[i++];
                const parse = (): any[] => {
                    const x = next();
                    switch (x) {
                        case "`":
                            return [parse(), parse()];
                        case "s":
                        case "k":
                        case "i":
                        case "d":
                        case "c":
                        case "v":
                        case "r":
                            return ["$", x];
                        case ".":
                            return ["fn", ["x"], ["out", next()], ["$", "x"]];
                        default:
                            throw "invalid character " + x;
                    }
                }
                expect(run(vm, ["begin",
                    ["define", ["out", "c"], [(c: string) => { out += c; if (autostop && out.length === expectedOutput.length) vm.commandStack = null; }, ["$", "c"]]],
                    ["define", ["s", "x"], ["fn", ["y"], ["fn", ["z"], [["x", ["$", "z"]], ["y", ["$", "z"]]]]]],
                    ["define", ["k", "x"], ["fn", ["_"], ["$", "x"]]],
                    ["define", ["i", "x"], ["$", "x"]],
                    ["define", ["v", "x"], ["$", "v"]],
                    ["define", ["r", "x"], ["out", "\n"], ["$", "x"]],
                    ["define", ["d", [false, "x"]], ["fn", ["y"], [["x"], ["$", "y"]]]],
                    ["define", ["c", "x"], ["x", ["$", "return"]]],
                    parse(),
                ])).toBeTrue();
                expect(out).toEqual(expectedOutput);
            });
        }
        unlambda("hello world", "`````````````.H.e.l.l.o.,. .w.o.r.l.d.!i", "Hello, world!");
        unlambda("hello world 2", "`.!`.d`.l`.r``.w`. `.,``.l`c`.H.e.oi", "Hello, world!");
        unlambda("defer", "`.c``d`.bi`.ai", "abc");
        unlambda("yin-yang", "``r`ci`.*`ci", new Array(200).fill(0).map((_, i) => "*".repeat(i)).join("\n"), true);
        unlambda("fibonacci printer", "```s``s``sii`ki`k.*``s``s`ks``s`k`s`ks``s``s`ks``s`k`s`kr``s`k`sikk`k``s`ksk", new Array(20).fill(0).map((_, i) => "*".repeat(float(fibonacci(int(i))))).join("\n"), true);
    });
});

describe("FFI", () => {
    testTest(test, "FFI calling functions", (vm, out) => {
        expect(run(vm, ["begin",
            [(arg: any) => { out.push(arg, { a: 1 } as any); }, "hi"]
        ])).toBeTrue();
        expect(out).toEqual(["hi", { a: 1 } as any]);
    });
    testTest(test, "FFI get function is bound", vm => {
        expect(run(vm, ["begin",
            ["let", [["x", { a: 7, b() { return this.a * 6; } }]],
                [[".", ["$", "x"], "b"]]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(42);
    });
    testTest(test, "FFI function callbacks", (vm, out) => {
        const thrice = (f: (x: string) => void, x: string) => (f(x), f(x), f(x));
        expect(() => run(vm, ["begin",
            ["let", [["x", ["fn", ["x"], ["print", ["$", "x"]]]]],
                [thrice, ["$", "x"], "hi"],
                [thrice, ["$", "x"], "bye"]]
        ])).toThrow("cannot call JEB fn");
        // expect(out).toEqual(["hi", "hi", "hi", "bye", "bye", "bye"]);
    });
});

describe("audit hook protections", () => {
    testTest(test, "prevents accessing Function", vm => {
        vm.addAuditHook(makeSingleEventWatcher("jeb:ffi/object/get", (obj, key) => {
            if (obj[key] === Function) {
                throw new JEBError("can't access that!");
            }
        }));
        expect(() => run(vm, [".", [".", {}, "constructor"], "constructor"])).toThrow("can't access that!");
    });
    testTest(test, "infinite loop guard", vm => {
        vm.addAuditHook(makeSingleEventWatcher("jeb:loop_check", (count) => {
            if (count > 10000) {
                throw new JEBError("too many loops");
            }
        }));
        expect(() => run(vm, [
            ["let", "loop", [], ["loop"]]
        ], 10000000)).toThrow("too many loops");
    });
});

describe("location tracking", () => {
    testTest(test, "tracks locations", vm => {
        expect.assertions(7);
        try {
            run(vm, ["at", "line 0", ["begin",
                ["define", ["f"], ["at", "line 1", ["g"]]],
                ["define", ["g"], ["at", "line 2", ["h"]]],
                ["define", ["h"], ["at", "line 3", ["error"]]],
                ["at", "line 4", ["f"]],
            ]]);
        } catch (e2: any) {
            const e: JEBError = e2;
            expect(e).toBeInstanceOf(JEBError);
            expect(e.traceback).toBeDefined();
            expect(e.traceback!.some(e => e.leaf && e.location === "line 0")).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location === "line 1")).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location === "line 2")).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location === "line 3")).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location === "line 4")).toBeTrue();
        }
    });
});

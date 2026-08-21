import { describe, expect, test } from "bun:test";
import { parse, stringify } from "lib0/json";
import { defineBuiltin, JebVM, typeMatches } from "../src";

const testTest = (name: string, testBody: (vm: JebVM, out: string[]) => void) => {
    const vm = new JebVM();
    const out: string[] = [];
    // simple print hook for the tests
    defineBuiltin(vm, "print", ["args", true], ({ args }) => void out.push(args.map(String).join(" ")), "test print");
    test(name, () => testBody(vm, out));
}

const run = (vm: JebVM, code: any, steps = Infinity, recursionLimit = 10000) => {
    vm.start(code);
    for (var i = 0; i < steps; i++) {
        if (!vm.step()) return true;
        vm.checkRecursion(recursionLimit);
    }
    return false;
}

const rawTraceback = (vm: JebVM): string[] => {
    const res: string[] = [];
    var t = vm.tracebackStack;
    while (t) { res.push(t.value.name); t = t.next; }
    return res;
}

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
    testTest("identity", vm => {
        vm.pushData(1);
        vm.pushData(2);
        vm.pushData(3);
        vm.pushData(4);
        vm.pushData(5);
        vm.pushCommand("jeb:shuffle", 5, [0, 1, 2, 3, 4]);
        vm.step();
        expect(vm.popData()).toEqual(5);
        expect(vm.popData()).toEqual(4);
        expect(vm.popData()).toEqual(3);
        expect(vm.popData()).toEqual(2);
        expect(vm.popData()).toEqual(1);
    });
    testTest("tuck", vm => {
        vm.pushData(1);
        vm.pushData(2);
        vm.pushCommand("jeb:shuffle", 2, [1, 0, 1]);
        vm.step();
        expect(vm.popData()).toEqual(2);
        expect(vm.popData()).toEqual(1);
        expect(vm.popData()).toEqual(2);
    });
});

describe("basic", () => {
    testTest("begin with no args returns null", vm => {
        expect(run(vm, ["begin"])).toBeTrue();
        expect(vm.popData()).toBeNull();
    });
    describe("undefined", () => {
        testTest("getting variable", vm => {
            expect(() => run(vm, ["$", "nonexistent"])).toThrow('variable "nonexistent" not found');
        });
        testTest("setting variable", vm => {
            expect(() => run(vm, ["set", ["$", "nonexistent"], 1])).toThrow('variable "nonexistent" not found');
        });
        testTest("function", vm => {
            expect(() => run(vm, ["nonexistent"])).toThrow('function "nonexistent" not found');
        });
    });
    testTest("basic commands", (vm, out) => {
        expect(run(vm, ["begin", ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest("basic commands wrapped in fn", (vm, out) => {
        expect(run(vm, [["fn", [], ["print", "hi 1"], ["print", "hi 2"], ["print", "hi 3"]]])).toBeTrue();
        expect(out).toEqual(["hi 1", "hi 2", "hi 3"]);
    });
    testTest("get complex value", vm => {
        expect(run(vm, ["begin",
            ["define", ["x"], ["list", ["list", 1], ["list", 2], ["list", 4]]],
            [".", [".", ["x"], 1], 0],
        ])).toBeTrue();
        expect(vm.popData()).toBe(2);
    });
    testTest("set with existing value", (vm, out) => {
        expect(run(vm, ["begin",
            ["let-in", "x", 0],
            ["print", ["set", ["$", "x"], 10]],
            ["print", ["$", "x"]],
            ["print", ["set", ["$", "x"], ["+", 1, ["$", "_"]]]],
            ["print", ["$", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "10", "11", "11"]);
    });
    testTest("get with computed indexing", vm => {
        expect(run(vm, ["begin",
            ["let-in", "x", ["list", 1, 2, 3]],
            [".", ["$", "x"], [".", ["$", "x"], 0]]
        ])).toBeTrue();
        expect(vm.popData()).toEqual(2);
    });
    testTest("set with old value", (vm, out) => {
        expect(run(vm, ["begin",
            ["let-in", "x", 0],
            ["print", ["set", ["$", "x"], 10, true]],
            ["print", ["$", "x"]],
            ["print", ["set", ["$", "x"], ["+", 1, ["$", "_"]], true]],
            ["print", ["$", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["0", "10", "10", "11"]);
    });
    testTest("set complex value lvalue is only evaluated once", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "value", { x: 1 }],
            ["define", ["f"], ["print", "called"], ["$", "value"]],
            ["set", [".", ["f"], "x"], ["+", 10, ["$", "_"]]],
            ["$", "value"],
        ])).toBeTrue();
        expect(vm.popData()).toEqual({ x: 11 });
        expect(out).toEqual(["called"]);
    });
    testTest("calling non-functions errors", vm => {
        expect(() => run(vm, [1, 2, 3])).toThrow("can't call number");
    });
    testTest("math overload error", vm => {
        expect(() => run(vm, ["+", "hi", 1])).toThrow("No overload of add exists for types string, number")
    });
    testTest("boolean short-circuiting", (vm, out) => {
        expect(run(vm, ["begin",
            ["or", true, ["print", "a"]],
            ["or", false, ["print", "b"]],
            ["and", 0, ["print", "a"]],
        ])).toBeTrue();
        expect(vm.popData()).toEqual(0);
        expect(out).toEqual(["b"]);
    });
    testTest("json error 1", vm => {
        try {
            parse("[");
        } catch (error: any) {
            expect(() => run(vm, ["parseJSON", "["])).toThrow(error.message);
        }
    });
    testTest("json error 2", vm => {
        try {
            const x: any = [];
            x[0] = x;
            stringify(x);
        } catch (error: any) {
            expect(() => run(vm, ["begin",
                ["let-in", "x", ["list"]],
                ["set", [".", ["$", "x"], 0], ["$", "x"]],
                ["dumpJSON", ["$", "x"]]
            ])).toThrow(error.message);
        }

    });
    testTest("property chain get", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            [".", [".", [".", ["$", "x"], "a"], "b"], "foo"],
        ])).toBeTrue();
        expect(vm.popData()).toEqual(123);
    });
    testTest("property chain set", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["set", [".", [".", [".", ["$", "x"], "a"], "b"], "foo"], ["+", ["$", "_"], 333]],
            ["$", "x"]
        ])).toBeTrue();
        expect(vm.popData()).toEqual({ a: { b: { foo: 456 } } });
    });
});

describe("tail-call elimination", () => {
    testTest("command stack stays constant", vm => {
        expect(run(vm, ["begin",
            ["define", ["loop"], ["loop"]],
            ["loop"]
        ], 5000)).toBeFalse();

        // with TCO the stack never grows beyond a handful of ops
        expect(vm.recursionDepth).toBeLessThan(10);
        // traceback is a single self-referential frame + top-level begin
        expect(rawTraceback(vm)).toEqual(["loop", "begin"]);
    });

    testTest("tail frames are still dropped on return", (vm, out) => {
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

    testTest("non-tail frames are kept", vm => {
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
    testTest("compresses long alternating cycle", vm => {
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

    testTest("nests cycles", vm => {
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
    testTest("runs before then body then after and returns body", (vm, out) => {
        expect(run(vm, makeWith("before", "after", ["print", "body"], 123))).toBeTrue();
        expect(vm.popData()).toEqual(123);
        expect(out).toEqual(["before false", "body", "after false null"]);
    });

    testTest("after runs on error", (vm, out) => {
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

    testTest("nested with unwinds in stack order", (vm, out) => {
        expect(run(vm, makeWith("enter outer", "exit outer", makeWith("enter inner", "exit inner", null)))).toBeTrue();
        expect(out).toEqual(["enter outer false", "enter inner false", "exit inner false null", "exit outer false null"]);
    });

    testTest("continuation re-enters with", (vm, out) => {
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

    testTest("continuation escapes with (after runs once)", (vm, out) => {
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

    testTest("uncaught errors retain full traceback", vm => {
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

    testTest("with requires variable name or null", vm => {
        expect(() => run(vm, ["with", { enter: null, exit: null }, false])).toThrow('expected variable name or null as first argument to "with"')
    });
    testTest("with requires context object", vm => {
        expect(() => run(vm, ["with", null, null, false])).toThrow("context manager should be an object")
    });

    testTest("continuation can be called with computed value", vm => {
        expect(run(vm, ["begin",
            ["let-in", "x", null],
            ["let-in", "y", [["fn", ["f"], ["f", ["$", "return"]]], ["fn", ["k"], ["set", ["$", "x"], ["$", "k"]]]]],
            ["if", ["=", ["$", "y"], 123],
                null,
                ["x", ["+", 23, 100]]],
            ["$", "y"],
        ])).toBeTrue();
        expect(vm.popData()).toEqual(123);
    });
});

describe("metaprogramming", () => {
    testTest("eval", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "x", ["'", ["print", ["$", "a"]]]],
            ["let", [["a", "hello"]], ["eval", ["$", "x"]]],
        ])).toBeTrue();
        expect(out).toEqual(["hello"]);
    });
    testTest("user-defined macros", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["twice", [true, "x"]], ["macro", ["list", "+", ["$", "x"], ["$", "x"]]]],
            ["print", ["twice", 2]],
            ["print", ["twice", "hello"]],
            ["let", [["a", 4]], ["print", ["twice", ["begin", ["print", "arg evaluated"], ["$", "a"]]]]]
        ])).toBeTrue();
        expect(out).toEqual(["4", "hellohello", "arg evaluated", "arg evaluated", "8"]);
    });
    testTest("quote/quasiquote", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "a", 1],
            ["define", "b", 2],
            ["define", "c", 3],
            ["define", "x", ["list", 4, 5, 6]],
            ["print", ["dumpJSON", ["'", ["foo", "bar", "baz"]]]],
            ["print", ["dumpJSON", ["~", ["foo", "bar", "baz"]]]],
            ["print", ["dumpJSON", ["~", ["foo", "bar", ["baz"]]]]],
            ["print", ["dumpJSON", ["~", ["foo", "bar", [",", ["$", "a"]]]]]],
            ["print", ["dumpJSON", ["'", ["foo", "bar", [",", ["$", "a"]]]]]],
            ["print", ["dumpJSON", ["~", ["foo", "bar", [",", ["$", "x"]]]]]],
            ["print", ["dumpJSON", ["~", ["foo", "bar", [",@", ["$", "x"]]]]]],
            ["let", [["y", ["list", 1, 2, 3]]], ["print", ["dumpJSON", ["~", ["foo", "bar", [",@", ["$", "y"]]]]]]],
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
    testTest("bad unquote 1", vm => {
        expect(() => run(vm, ["~", [","]])).toThrow("expected 1 argument to unquote");
    });
    testTest("bad unquote 2", vm => {
        expect(() => run(vm, [",", 1])).toThrow("unquote not valid outside of quasiquote");
    });
    testTest("bad unquoteSplicing 1", vm => {
        try {
            // @ts-expect-error
            [...1];
        } catch (e) {
            expect(() => run(vm, ["~", [[",@", 1], 2]])).toThrow(String(e));
        }
    });
    testTest("bad unquoteSplicing 2", vm => {
        expect(() => run(vm, ["~", [[",@"]]])).toThrow("expected 1 argument to unquoteSplicing");
    });
    testTest("bad unquoteSplicing 3", vm => {
        expect(() => run(vm, ["~", [",@", 1]])).toThrow("unquoteSplicing outside of list");
    });
    testTest("bad unquoteSplicing 4", vm => {
        expect(() => run(vm, [",@", 1])).toThrow("unquoteSplicing not valid outside of quasiquote");
    });
});

describe("keyword and splat arguments", () => {
    testTest("keyword arguments match by name regardless of order", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["dumpJSON", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["kw", "y", 2], ["kw", "x", 1]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest("positional splat arguments unpack iterables into positional slots", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["dumpJSON", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["splat", ["list", 1, 2]]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest("keyword splat arguments unpack objects into named slots", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["dumpJSON", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["splat", { x: 1, y: 2 }, true]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest("positional arguments can't follow keyword arguments", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["dumpJSON", ["list", ["$", "x"], ["$", "y"]]]]],
            ["pair", ["kw", "x", 1], 2],
        ])).toThrow("positional argument can't follow keyword argument");
    });

    testTest("missing arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y"]],
            ["foo", ["kw", "x", 1]],
        ])).toThrow('missing required parameter "y" of function "foo"');
    });

    testTest("too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, 3, 4],
        ])).toThrow('too many arguments to function "foo" (expected at most 3)');
    });

    testTest("unpacking too many arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x", "y", "z"]],
            ["foo", 1, 2, ["splat", ["list", 3, 4]]],
        ])).toThrow('too many elements in spread argument to function "foo" (at most 1 can be passed here)');
    });

    testTest("unknown keyword arguments errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", "x"]],
            ["foo", ["kw", "y", 1]],
        ])).toThrow('unexpected keyword argument "y" to function "foo"');
    });
});

describe("fns", () => {
    testTest("fn optional dynamic env", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["a", ["$", "x"]]], ["print", ["$", "a"]]],
            ["let", [["x", "hello"]], ["foo"], ["foo", "goodbye"]],
        ])).toBeTrue();
        expect(out).toEqual(["hello", "goodbye"]);
    });
    testTest("fn validation", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", ["a", 1, 2, 3]], ["print", ["$", "a"]]],
        ])).toThrow("unexpected junk after default expression");
    });
    testTest("spread arguments", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", "x", true], ["print", ["dumpJSON", ["$", "x"]]]],
            ["foo", 1, 2, 3],
            ["foo"]
        ])).toBeTrue();
        expect(out).toEqual(["[1,2,3]", "[]"]);
    });
    testTest("required must follow optional", vm => {
        expect(() => run(vm, ["define", ["foo", ["x", 1], "y"], false])).toThrow('required parameter "y" cannot follow optional parameter');
    });
    testTest("bad params", vm => {
        expect(() => run(vm, ["define", ["foo", 1], false])).toThrow("arg name not found at position 0");
    });
    testTest("let loop", (vm, out) => {
        expect(run(vm, ["begin",
            ["let", "loop", [["x", 10]],
                ["print", ["$", "x"]],
                ["if", [">", ["$", "x"], 0],
                    ["loop", ["-", ["$", "x"], 1]]]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    });
    testTest("bad define", vm => {
        expect(() => run(vm, ["define", 1])).toThrow("invalid define syntax")
    });
});

describe("recursion stress tests", () => {
    testTest("A000142 (factorial)", vm => {
        const x = 5000n;
        const factorial = (a: bigint): bigint => a > 1 ? a * factorial(a - 1n) : 1n;
        expect(run(vm, ["begin",
            ["define", ["factorial", "a"],
                ["if", [">", ["$", "a"], 1],
                    ["*", ["factorial", ["-", ["$", "a"], 1n]], ["$", "a"]],
                    1n]],
            ["factorial", x]
        ], undefined, 10000000)).toBeTrue();
        expect(vm.popData()).toEqual(factorial(x));
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
    testTest("A000045 (Fibonacci sequence)", vm => {
        const x = 5000n;
        const fibonacci = MEMOIZE_F(a => a < 2 ? a : fibonacci(a - 1n) + fibonacci(a - 2n));
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
        expect(vm.popData()).toEqual(fibonacci(x));
    });
    testTest("A005185 (Hofstadter 'Q' sequence)", vm => {
        const x = 5000n;
        const q = MEMOIZE_F(a => a < 3 ? 1n : q(a - q(a - 1n)) + q(a - q(a - 2n)));
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
        expect(vm.popData()).toEqual(Number(q(x)));
    });
    testTest("A063510", vm => {
        const x = 1e20;
        const A063510 = (a: number): number => a < 2 ? 1 : 1 + A063510(a ** 0.5 | 0);
        expect(run(vm, ["begin",
            ["define", ["A063510", "a"],
                ["if", ["<", ["$", "a"], 2],
                    1,
                    ["+", 1, ["A063510", ["bit-or", 0, ["pow", ["$", "a"], 0.5]]]]]],
            ["A063510", x],
        ])).toBeTrue();
        expect(vm.popData()).toEqual(A063510(x));
    });
});

describe("FFI", () => {
    testTest("FFI calling functions", (vm, out) => {
        expect(run(vm, ["begin",
            [(arg: any) => { out.push(arg, { a: 1 } as any); }, "hi"]
        ])).toBeTrue();
        expect(out).toEqual(["hi", { a: 1 } as any]);
    });
    testTest("FFI get function is bound", vm => {
        expect(run(vm, ["begin",
            ["let", [["x", { a: 7, b() { return this.a * 6; } }]],
                [[".", ["$", "x"], "b"]]]
        ])).toBeTrue();
        expect(vm.popData()).toEqual(42);
    });
    testTest("FFI function callbacks", (vm, out) => {
        const thrice = (f: (x: string) => void, x: string) => (f(x), f(x), f(x));
        expect(() => run(vm, ["begin",
            ["let", [["x", ["fn", ["x"], ["print", ["$", "x"]]]]],
                [thrice, ["$", "x"], "hi"],
                [thrice, ["$", "x"], "bye"]]
        ])).toThrow("cannot call JEB fn");
        // expect(out).toEqual(["hi", "hi", "hi", "bye", "bye", "bye"]);
    });
});

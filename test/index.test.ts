import { describe, expect, test } from "bun:test";
import { stringify } from "lib0/json";
import { defineBuiltin, JebVM } from "../src";

function testTest(name: string, testBody: (vm: JebVM, out: string[]) => void) {
    const vm = new JebVM();
    const out: string[] = [];
    // simple print hook for the tests
    defineBuiltin(vm, "print", null, false, false, args => void out.push(args.map(String).join(" ")), "test print");
    test(name, () => testBody(vm, out));
}

function run(vm: JebVM, code: any, steps = Infinity, recursionLimit = 10000) {
    vm.start(code);
    for (var i = 0; i < steps; i++) {
        if (!vm.step(false)) return true;
        vm.checkRecursion(recursionLimit);
    }
    return false;
}

function rawTraceback(vm: JebVM): string[] {
    const res: string[] = [];
    var t = vm.tracebackStack;
    while (t) { res.push(t.value); t = t.next; }
    return res;
}

describe("basic", () => {
    testTest("begin with no args returns null", vm => {
        expect(run(vm, ["begin"])).toBeTrue();
        expect(vm.peekData()).toBeNull();
    });
    describe("undefined", () => {
        testTest("getting variable", vm => {
            expect(() => run(vm, ["$", "nonexistent"])).toThrow("variable \"nonexistent\" not found");
        });
        testTest("setting variable", vm => {
            expect(() => run(vm, ["set", "nonexistent", 1])).toThrow("variable \"nonexistent\" not found");
        });
        testTest("function", vm => {
            expect(() => run(vm, ["nonexistent"])).toThrow("function \"nonexistent\" not found");
        });
    });
    testTest("calling non-functions errors", vm => {
        expect(() => run(vm, [1, 2, 3])).toThrow("can't call number");
    });
    testTest("math overload error", vm => {
        expect(() => run(vm, ["+", "hi", 1])).toThrow("No overload of \"add\" found for types \"string\", \"number\"")
    });
    testTest("boolean short-circuiting", (vm, out) => {
        expect(run(vm, ["begin",
            ["or", true, ["print", "a"]],
            ["or", false, ["print", "b"]],
            ["and", 0, ["print", "a"]],
        ])).toBeTrue();
        expect(vm.peekData()).toEqual(0);
        expect(out).toEqual(["b"]);
    });
    testTest("json error 1", vm => {
        expect(() => run(vm, ["parseJSON", "["])).toThrow();
    });
    testTest("json error 2", vm => {
        expect(() => run(vm, ["begin",
            ["let", [["x", ["list", null]]],
                ["set_prop", ["$", "x"], 0, ["$", "x"]],
                ["dumpJSON", ["$", "x"]]]
        ])).toThrow();
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
        var err: any;
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["bar"]],
                ["define", ["bar"], ["print", "hello"]],
                ["foo"],
                ["foo"],
                ["error", "test", "test", {}]
            ]);
        } catch (e) { err = e; }

        expect(out).toEqual(["hello", "hello"]);
        // foo and bar were tail-called, only begin and error survive
        expect(err.message).toContain("VM stack: error<-begin");
        expect(err.message).not.toContain("foo");
        expect(err.message).not.toContain("bar");
    });

    testTest("non-tail frames are kept", vm => {
        var err: any;
        try {
            run(vm, ["begin",
                ["define", ["f"], ["+", 1, ["g"]]],
                ["define", ["g"], ["error", "x", "y", {}]],
                ["f"]
            ]);
        } catch (e) { err = e; }

        // f → g is NOT a tail call (it's an argument), so both stay
        const msg = err.message;
        expect(msg).toMatch(/error/);
        expect(msg).toMatch(/g/);
        expect(msg).toMatch(/f/);
        expect(msg).toMatch(/begin/);
    });
});

describe("traceback compression", () => {
    testTest("compresses long alternating cycle", vm => {
        // a ↔ b tail recursion
        expect(run(vm, ["begin",
            ["define", ["a"], ["b"]],
            ["define", ["b"], ["a"]],
            ["a"]
        ], 6000)).toBeFalse();

        // force an error to snapshot the stack
        vm.pushCommand("throw", "boom", "x", {});
        var err: any;
        try { for (; vm.step();); } catch (e) { err = e; }

        // should be "(a<-b * N)" not a zillion repeats
        expect(err.message).toMatch(/\(a<-b \* \d+\)/);
        expect(err.message).not.toMatch(/a<-b<-a<-b<-a<-b<-a<-b/);
    });

    testTest("nests cycles", vm => {
        const prog = ["begin",
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
        ];
        var err: any;
        try { run(vm, prog); } catch (e) { err = e; }

        expect(err.message).toMatch(/\(if<-foo<-bar \* \d+\)/);
        expect(err.message).toMatch(/\([^()]+\(/);
    });
});


describe("with / dynamic-wind", () => {

    const makeWith = (begin: string, end: string, ...body: any[]) => {
        return ["with", null,
            ["obj", {
                enter: ["lambda", ["k"], "",
                    ["print", begin, ["$", "k"]]],
                exit: ["lambda", ["k", "type", "value", "restarts"], "",
                    ["print",
                        end,
                        ["$", "k"],
                        ["$", "type"],
                        ["$", "value"],
                        ["$", "restarts"]]]
            }],
            ...body
        ];
    }
    testTest("runs before then body then after", (vm, out) => {
        run(vm, makeWith("before", "after", ["print", "body"]));
        expect(out).toEqual(["before false", "body", "after false null null null"]);
    });

    testTest("after runs on error", (vm, out) => {
        var err: any;
        try {
            run(vm, makeWith("before", "after", ["error", "runtime_error", "boom", {}]));
        } catch (e) { err = e; }
        expect(err.message).toContain("boom");
        expect(err.message).toContain("VM stack: error<-with");
        expect(out).toEqual(["before false", "after false runtime_error boom [object Object]"]);
    });

    testTest("nested with unwinds in stack order", (vm, out) => {
        expect(run(vm, makeWith("enter outer", "exit outer", makeWith("enter inner", "exit inner", null)))).toBeTrue();
        expect(out).toEqual(["enter outer false", "enter inner false", "exit inner false null null null", "exit outer false null null null"]);
    });

    testTest("continuation re-enters with", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "k", null],
            makeWith("enter", "exit",
                [["lambda", [], "", ["set", "k", ["$", "return"]]]],
                ["print", "inside"]),
            ["print", "outside"],
            ["k", null],          // jump back into the with
            ["error", "unreachable_error", "unreachable", {}]
        ], 2000)).toBeFalse();

        const init = [
            "enter false",
        ];
        const repeated = [
            "inside",
            "exit false null null null",
            "outside",
            "enter true",
        ];
        for (var i = 0; init.length < out.length; i = (i + 1) % repeated.length) {
            init.push(repeated[i]!);
        }
        expect(out).toEqual(init);
    });

    testTest("continuation escapes with (after runs once)", (vm, out) => {
        // escape from inside with via a continuation captured outside
        run(vm, ["begin",
            [["lambda", [], "",
                makeWith("enter", "exit",
                    ["print", "inside"],
                    ["return", null],
                    ["error", "unreachable_error", "unreachable", {}])
            ]],
            ["print", "outside"]
        ]);

        expect(out).toEqual(["enter false", "inside", "exit true null null null", "outside"]);
    });

    testTest("uncaught errors retain full traceback", vm => {
        var err: any;
        try {
            run(vm, ["begin",
                ["define", ["foo"], ["error"]],
                makeWith("", "", makeWith("", "", makeWith("", "", ["foo"])))
            ]);
        } catch (e) { err = e; }
        expect(err.message).toContain("foo");
    });

    testTest("with requires variable name or null", vm => {
        expect(() => run(vm, ["with", { enter: null, exit: null }, false])).toThrow("expected variable name as first argument to 'with'")
    });
    testTest("with requires context object", vm => {
        expect(() => run(vm, ["with", null, null, false])).toThrow("context manager should be an object")
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
            ["define", true, ["twice", "x"], ["list", "+", ["$", "x"], ["$", "x"]]],
            ["print", ["twice", 2]],
            ["print", ["twice", "hello"]],
            ["print", ["twice", ["begin", ["print", "arg evaluated"], NaN]]],
        ])).toBeTrue();
        expect(out).toEqual(["4", "hellohello", "arg evaluated", "arg evaluated", "NaN"]);
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
        ])).toBeTrue();
        expect(out).toEqual([
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", ["baz"]]),
            stringify(["foo", "bar", 1]),
            stringify(["foo", "bar", [",", ["$", "a"]]]),
            stringify(["foo", "bar", [4, 5, 6]]),
            stringify(["foo", "bar", 4, 5, 6]),
        ]);
    });
    testTest("bad quasiquote 1", vm => {
        expect(() => run(vm, ["~", [[",@", 1], 2]])).toThrow("not an array to concat");
    });
    testTest("bad quasiquote 2", vm => {
        expect(() => run(vm, ["~", [","]])).toThrow("expected argument to unquote");
    });
    testTest("bad unquote", vm => {
        expect(() => run(vm, [",", 1])).toThrow("unquote not valid outside of quasiquote");
    });
    testTest("bad unquoteSplicing", vm => {
        expect(() => run(vm, [",@", 1])).toThrow("unquoteSplicing not valid outside of quasiquote");
    });
});

describe("lambdas", () => {
    testTest("lambda optional dynamic env", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["a", ["$", "x"]]], ["print", ["$", "a"]]],
            ["let", [["x", "hello"]], ["foo"], ["foo", "goodbye"]],
        ])).toBeTrue();
        expect(out).toEqual(["hello", "goodbye"]);
    });
    testTest("lambda validation", (vm, out) => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", ["a", 1, 2, 3]], ["print", ["$", "a"]]],
        ])).toThrow("invalid optional argument");
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
        expect(() => run(vm, ["define", ["foo", ["x", 1], "y"], false])).toThrow("required parameter cannot follow optional parameter");
    });
    testTest("bad params", vm => {
        expect(() => run(vm, ["define", ["foo", 1], false])).toThrow("invalid parameter to lambda");
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
    testTest("bad define", vm =>{
        expect(() => run(vm, ["define", 1])).toThrow("invalid define syntax")
    });
});

describe("recursion stress tests", () => {
    testTest("A000142 (factorial)", (vm, out) => {
        const x = 5000n;
        const factorial = (a: bigint): bigint => a > 1 ? a * factorial(a - 1n) : 1n;
        expect(run(vm, ["begin",
            ["define", ["factorial", "a"],
                ["if", [">", ["$", "a"], 1],
                    ["*", ["factorial", ["-", ["$", "a"], 1n]], ["$", "a"]],
                    1n]],
            ["print", ["factorial", x]]
        ], undefined, 10000000)).toBeTrue();
        expect(out).toEqual([String(factorial(x))]);
    });
    const MEMOIZE_F = (f: (a: bigint) => bigint) => { const cache: Record<number, bigint> = {}; return (a: bigint) => (cache[a as any] ??= f(a)) }
    const MEMOIZE = ["define", ["memoize", "f"],
        ["let", [["cache", ["obj", {}]]],
            ["lambda", ["a"], "",
                ["let", [["cached", ["get_prop", ["$", "cache"], ["$", "a"]]]],
                    ["if", ["nil?", ["$", "cached"]],
                        ["set_prop", ["$", "cache"], ["$", "a"], ["f", ["$", "a"]]],
                        ["$", "cached"]]]]]
    ];
    testTest("A000045 (Fibonacci sequence)", (vm, out) => {
        const x = 5000n;
        const fibonacci = MEMOIZE_F(a => a < 2 ? a : fibonacci(a - 1n) + fibonacci(a - 2n));
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "fibonacci", ["memoize", ["lambda", ["a"], "",
                ["if", ["<", ["$", "a"], 2],
                    ["$", "a"],
                    ["+",
                        ["fibonacci", ["-", ["$", "a"], 1]],
                        ["fibonacci", ["-", ["$", "a"], 2]]]]]]],
            ["print", ["fibonacci", x]]
        ], undefined, 10000000)).toBeTrue();
        expect(out).toEqual([String(fibonacci(x))]);
    });
    testTest("A005185 (Hofstadter 'Q' sequence)", (vm, out) => {
        const x = 5000n;
        const q = MEMOIZE_F(a => a < 3 ? 1n : q(a - q(a - 1n)) + q(a - q(a - 2n)));
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "q", ["memoize", ["lambda", ["a"], "",
                ["if", ["<", ["$", "a"], 3],
                    1,
                    ["+",
                        ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 1]]]],
                        ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 2]]]]]]]]],
            ["print", ["q", x]]
        ], undefined, 10000000)).toBeTrue();
        expect(out).toEqual([String(q(x))]);
    });
    testTest("A063510", (vm, out) => {
        const x = 1e20;
        const A063510 = (a: number): number => a < 2 ? 1 : 1 + A063510(a ** 0.5 | 0);
        expect(run(vm, ["begin",
            ["define", ["A063510", "a"],
                ["if", ["<", ["$", "a"], 2],
                    1,
                    ["+", 1, ["A063510", ["bit-or", 0, ["pow", ["$", "a"], 0.5]]]]]],
            ["print", ["A063510", x]],
        ])).toBeTrue();
        expect(out).toEqual([String(A063510(x))]);
    });
    testTest("map and reduce", vm => {
        const x = 2000, n = 3;
        expect(run(vm, ["begin",
            ["define", "x", ["list", ...new Array(x).fill(0).map((_, i) => i)]],
            ["map", ["$", "x"], ["lambda", ["x"], ["*", n, ["$", "x"]]]]
        ])).toBeTrue();
        expect(vm.peekData()).toEqual(new Array(x).fill(0).map((_, i) => i * n));
    });
});

describe("self-defined macros", () => {
    testTest("when/unless", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "a", true],
            ["when", ["$", "a"], ["print", "hi"]],
            ["unless", ["$", "a"], ["print", "bye"]]
        ])).toBeTrue();
        expect(out).toEqual(["hi"]);
    });
    const makeTryCatch = (body: any) => ["try",
        body,
        {
            bar_error: ["lambda", ["message", "restarts"], "",
                ["print", "caught bar!", ["$", "message"]]],
            "*": ["lambda", ["type", "message", "restarts"], "",
                ["print", "caught star!", ["$", "type"], ["$", "message"]]],
            else: ["lambda", [], "", ["print", "we didn't get an error"]]
        }];
    testTest("trycatch 1", (vm, out) => {
        expect(run(vm, ["begin",
            makeTryCatch(["error", "bar_error", "an error!", {}]),
        ])).toBeTrue();
        expect(out).toEqual(["caught bar! an error!"]);
    });
    testTest("trycatch 2", (vm, out) => {
        expect(run(vm, ["begin",
            makeTryCatch(["error", "foo_error", "foo error!", {}]),
        ])).toBeTrue();
        expect(out).toEqual(["caught star! foo_error foo error!"]);
    });
    testTest("trycatch 3", (vm, out) => {
        expect(run(vm, ["begin",
            makeTryCatch(["print", "nothing to see here"]),
        ])).toBeTrue();
        expect(out).toEqual(["nothing to see here", "we didn't get an error"]);
    });
    testTest("with-baffle 1", vm => {
        expect(() => run(vm, ["begin",
            ["define", "x", null],
            ["call/cc", ["lambda", ["k"], ["set", "x", ["$", "k"]]]],
            ["with-baffle",
                ["x", null]]
        ])).toThrow("tried to jump out of a 'with-baffle' block");
    });
    testTest("with-baffle 2", vm => {
        expect(() => run(vm, ["begin",
            ["define", "x", null],
            ["with-baffle",
                ["call/cc", ["lambda", ["k"], ["set", "x", ["$", "k"]]]]],
            ["x", null]
        ])).toThrow("tried to jump into a 'with-baffle' block");
    });
    testTest("pipe", vm => {
        expect(run(vm, ["begin",
            ["|>", 1, ["*", ["$", "#"], 100], ["+", ["$", "#"], 23]]
        ])).toBeTrue();
        expect(vm.peekData()).toEqual(123);
    });
});

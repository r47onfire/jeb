import { describe, expect, test } from "bun:test";
import { parse, stringify } from "lib0/json";
import { argumentLocation, define, ErrnoCode, float, Fun, int, JEBError, JebVM, makeJSFun, OP_get, OP_set, OP_shuffle, OP_unwrap, popData, promisifyVM, pushCommand, pushData, StackEntryKind, typecheck, typeMatches, withType, Wrapper } from "../src";
import { makeTestRun, rawTraceback, run, runAsync } from "../src/indextest";

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
            expect(() => run(vm, ["local", "nonexistent"])).toThrow('variable "nonexistent" not found');
        });
        testTest(test, "setting variable", vm => {
            expect(() => run(vm, ["assign", ["local", "nonexistent"], 1])).toThrow('variable "nonexistent" not found');
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
            ["index", ["index", ["x"], 1], 0],
        ])).toBeTrue();
        expect(popData(vm)).toBe(2);
    });
    testTest(test, "set with existing value", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["print", ["assign", ["local", "x"], 10]],
            ["print", ["local", "x"]],
            ["print", ["assign", ["local", "x"], ["add", 1, ["local", "_"]]]],
            ["print", ["local", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["10", "10", "11", "11"]);
    });
    testTest(test, "get with computed indexing", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", ["list", 1, 2, 3]],
            ["index", ["local", "x"], ["index", ["local", "x"], 0]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "set with old value", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["print", ["assign", ["local", "x"], 10, true]],
            ["print", ["local", "x"]],
            ["print", ["assign", ["local", "x"], ["add", 1, ["local", "_"]], true]],
            ["print", ["local", "x"]]
        ])).toBeTrue();
        expect(out).toEqual(["0", "10", "10", "11"]);
    });
    testTest(test, "set complex value lvalue is only evaluated once", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "value", { x: 1 }],
            ["define", ["f"], ["print", "called"], ["local", "value"]],
            ["assign", ["index", ["f"], "x"], ["add", 10, ["local", "_"]]],
            ["local", "value"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ x: 11 });
        expect(out).toEqual(["called"]);
    });
    testTest(test, "calling non-functions errors", vm => {
        expect(() => run(vm, [1, 2, 3])).toThrow("can't call number");
    });
    testTest(test, "math overload error", vm => {
        expect(() => run(vm, ["add", "hi", 1])).toThrow("No overload of add exists for types string, number")
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
            expect(() => run(vm, ["jsonParse", "["])).toThrow(error.message);
        }
    });
    testTest(test, "json error 2", vm => {
        try {
            const x: any = [];
            x[0] = x;
            stringify(x);
        } catch (error: any) {
            expect(() => run(vm, ["begin",
                ["letIn", "x", ["list"]],
                ["assign", ["index", ["local", "x"], 0], ["local", "x"]],
                ["jsonStringify", ["local", "x"]]
            ])).toThrow(error.message);
        }
    });
    testTest(test, "property chain get", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["index", ["index", ["index", ["local", "x"], "a"], "b"], "foo"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
    testTest(test, "property chain set", vm => {
        expect(run(vm, ["begin",
            ["define", "x", { a: { b: { foo: 123 } } }],
            ["assign", ["index", ["index", ["index", ["local", "x"], "a"], "b"], "foo"], ["add", ["local", "_"], 333]],
            ["local", "x"]
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ a: { b: { foo: 456 } } });
    });
    testTest(test, "object with computed keys", vm => {
        const s = Math.random();
        expect(run(vm, ["object", s, "hello"])).toBeTrue();
        expect(popData(vm)).toEqual({ [s]: "hello" });
    });
    testTest(test, "object with splat keys", vm => {
        const s = Math.random();
        const t = Math.random();
        expect(run(vm, ["object", ["splat", { [s]: "hello" }, true], t, "bye"])).toBeTrue();
        expect(popData(vm)).toEqual({ [s]: "hello", [t]: "bye" });
    });
    testTest(test, "object with splat key override", vm => {
        const s = Math.random();
        expect(run(vm, ["object", ["splat", { [s]: "hello" }, true], s, "bye"])).toBeTrue();
        expect(popData(vm)).toEqual({ [s]: "bye" });
    });
    testTest(test, "object with splat key default", vm => {
        const s = Math.random();
        expect(run(vm, ["object", s, "bye", ["splat", { [s]: "hello" }, true]])).toBeTrue();
        expect(popData(vm)).toEqual({ [s]: "hello" });
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
            expect(err.toString()).toContain("traceback: err<-begin");
            expect(err.toString()).not.toContain("foo");
            expect(err.toString()).not.toContain("bar");
        }

    });

    testTest(test, "non-tail frames are kept", vm => {
        expect.assertions(1);
        try {
            run(vm, ["begin",
                ["define", ["f"], ["add", 1, ["g"]]],
                ["define", ["g"], ["throw", ["err", "foo"]]],
                ["f"]
            ]);
        } catch (err: any) {
            // f -> g is NOT a tail call (it's an argument), so both stay
            expect(err.toString()).toContain("traceback: err<-g<-f<-begin");
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
                    ["if", ["greater", ["local", "x"], 0],
                        ["bar", ["sub", ["local", "x"], 1]],
                        ["baz"]],
                    ["unreachable"]],
                ["define", ["bar", "x"],
                    ["foo", ["local", "x"]]],
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
                    ["print", begin, ["local", "k"]]],
                exit: ["fn", ["k", "err"],
                    ["print",
                        end,
                        ["local", "k"],
                        ["local", "err"]]]
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
            run(vm, makeWith("before", "after", ["throw", ["err", "EINTR", "boom"]]));
        } catch (err: any) {
            expect(err).toBeDefined();
            expect(err.toString()).toContain("boom");
            expect(err.toString()).toContain("traceback: err<-with");
            expect(out).toEqual(["before false", "after false [EINTR] boom\ntraceback: err<-with"]);
        }
    });

    testTest(test, "nested with unwinds in stack order", (vm, out) => {
        expect(run(vm, makeWith("enter outer", "exit outer", makeWith("enter inner", "exit inner", null)))).toBeTrue();
        expect(out).toEqual(["enter outer false", "enter inner false", "exit inner false null", "exit outer false null"]);
    });

    testTest(test, "continuation re-enters with", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "k", null],
            makeWith("enter", "exit",
                [["fn", [], ["assign", ["local", "k"], ["local", "return"]]]],
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
            ["letIn", "x", null],
            ["letIn", "y", [["fn", ["f"], ["f", ["local", "return"]]], ["fn", ["k"], ["assign", ["local", "x"], ["local", "k"]]]]],
            ["if", ["eq", ["local", "y"], 123],
                null,
                ["x", ["add", 23, 100]]],
            ["local", "y"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(123);
    });
});

describe("metaprogramming", () => {
    testTest(test, "eval", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "x", ["quote", ["print", ["local", "a"]]]],
            ["let", [["a", "hello"]], ["eval", ["local", "x"]]],
        ])).toBeTrue();
        expect(out).toEqual(["hello"]);
    });
    testTest(test, "user-defined macros", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["twice", [true, "x"]], ["macro", ["list", "add", ["local", "x"], ["local", "x"]]]],
            ["print", ["twice", 2]],
            ["print", ["twice", "hello"]],
            ["let", [["a", 4]], ["print", ["twice", ["begin", ["print", "arg evaluated"], ["local", "a"]]]]]
        ])).toBeTrue();
        expect(out).toEqual(["4", "hellohello", "arg evaluated", "arg evaluated", "8"]);
    });
    testTest(test, "macro expansions are named in tracebacks", vm => {
        expect.assertions(4);
        try {
            run(vm, ["begin",
                ["define", ["boom"], ["throw", ["err", "boom"]]],
                ["define", ["twice", [true, "x"]], ["macro", ["list", "add", ["local", "x"], ["local", "x"]]]],
                ["at", [9, 0], ["twice", ["boom"]]],
            ]);
        } catch (err: any) {
            const leaves = (err.traceback as any[]).filter(n => n.leaf);
            // the error came from code the macro constructed, and says so
            expect(err.toString()).toContain("<macro twice>");
            // the expansion frame sits between the expanded code and the caller,
            // located at the macro's call site
            const expansion = leaves.findIndex(n => n.name === "twice");
            expect(expansion).toBeGreaterThan(leaves.findIndex(n => n.name === "boom"));
            expect(leaves[expansion].location).toEqual([9, 0]);
            // the macro's own call frame was already popped; it is not duplicated
            expect(leaves.some(n => n.name === "twice" && n.kind === StackEntryKind.FUNCTION)).toBeFalse();
        }
    });
    testTest(test, "macro expansions evaluating to references are not unwrapped", vm => {
        // the expansion evaluates to a ReferenceWrapper, which set's
        // ref-flagged parameter must receive intact; expanding the
        // expansion's result may only expand further macro expansions,
        // never dereference (or otherwise unwrap) the value
        expect(run(vm, ["begin",
            ["define", ["m"], ["macro", ["list", "local", "x"]]],
            ["letIn", "x", 1],
            ["assign", ["m"], 42],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).toBe(42);
    });
    testTest(test, "macro expansions of macro calls nest their frames", vm => {
        expect.assertions(3);
        try {
            run(vm, ["begin",
                ["define", ["boom"], ["throw", ["err", "boom"]]],
                ["define", ["inner"], ["macro", ["list", "boom"]]],
                ["define", ["outer"], ["macro", ["list", "inner"]]],
                ["at", [9, 0], ["outer"]],
            ]);
        } catch (err: any) {
            const leaves = (err.traceback as any[]).filter(n => n.leaf);
            // each expansion gets its own frame, nested, at the call site
            const inner = leaves.findIndex(n => n.name === "inner");
            const outer = leaves.findIndex(n => n.name === "outer");
            expect(inner).toBeGreaterThan(leaves.findIndex(n => n.name === "boom"));
            expect(outer).toBeGreaterThan(inner);
            expect(leaves[inner].location).toEqual([9, 0]);
        }
    });
    testTest(test, "macro expansion frames do not leak after a successful expansion", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["twice", [true, "x"]], ["macro", ["list", "add", ["local", "x"], ["local", "x"]]]],
            ["print", ["twice", 3]],
        ])).toBeTrue();
        expect(out).toEqual(["6"]);
        expect(rawTraceback(vm)).toEqual([]);
    });
    testTest(test, "quote/quasiquote", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", "a", 1],
            ["define", "b", 2],
            ["define", "c", 3],
            ["define", "x", ["list", 4, 5, 6]],
            ["print", ["jsonStringify", ["quote", ["foo", "bar", "baz"]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", "baz"]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["baz"]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquote", ["local", "a"]]]]]],
            ["print", ["jsonStringify", ["quote", ["foo", "bar", ["unquote", ["local", "a"]]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquote", ["local", "x"]]]]]],
            ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquoteSplicing", ["local", "x"]]]]]],
            ["let", [["y", ["list", 1, 2, 3]]], ["print", ["jsonStringify", ["quasiquote", ["foo", "bar", ["unquoteSplicing", ["local", "y"]]]]]]],
        ])).toBeTrue();
        expect(out).toEqual([
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", "baz"]),
            stringify(["foo", "bar", ["baz"]]),
            stringify(["foo", "bar", 1]),
            stringify(["foo", "bar", ["unquote", ["local", "a"]]]),
            stringify(["foo", "bar", [4, 5, 6]]),
            stringify(["foo", "bar", 4, 5, 6]),
            stringify(["foo", "bar", 1, 2, 3]),
        ]);
    });
    testTest(test, "bad unquote 1", vm => {
        expect(() => run(vm, ["quasiquote", ["unquote"]])).toThrow("expected 1 argument to unquote");
    });
    testTest(test, "bad unquote 2", vm => {
        expect(() => run(vm, ["unquote", 1])).toThrow("unquote not valid outside of quasiquote");
    });
    testTest(test, "bad unquoteSplicing 1", vm => {
        try {
            // @ts-expect-error
            [...1];
        } catch (e) {
            expect(() => run(vm, ["quasiquote", [["unquoteSplicing", 1], 2]])).toThrow(String(e));
        }
    });
    testTest(test, "bad unquoteSplicing 2", vm => {
        expect(() => run(vm, ["quasiquote", [["unquoteSplicing"]]])).toThrow("expected 1 argument to unquoteSplicing");
    });
    testTest(test, "bad unquoteSplicing 3", vm => {
        expect(() => run(vm, ["quasiquote", ["unquoteSplicing", 1]])).toThrow("unquoteSplicing outside of list");
    });
    testTest(test, "bad unquoteSplicing 4", vm => {
        expect(() => run(vm, ["unquoteSplicing", 1])).toThrow("unquoteSplicing not valid outside of quasiquote");
    });
});

describe("references", () => {
    testTest(test, "require deref to change", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "y", ["ref", ["local", "x"]]],
            ["assign", ["local", "y"], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).not.toEqual(2);
    });
    testTest(test, "can be changed with deref", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "y", ["ref", ["local", "x"]]],
            ["assign", ["deref", ["local", "y"]], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "work with properties", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "y", ["ref", ["index", ["local", "x"], "foo"]]],
            ["assign", ["deref", ["local", "y"]], 2],
            ["local", "x"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual({ foo: 2 });
    });
    testTest(test, "transparently unwrap", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "y", ["ref", ["index", ["local", "x"], "foo"]]],
            ["deref", ["local", "y"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
});

describe("reactivity", () => {
    testTest(test, "runs when a watched variable is set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "does not run on registration", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "only runs after registration", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["assign", ["local", "x"], 1],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["local", "x"], 2],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "watcher sees the new value", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "seen", 0],
            ["always", false, ["assign", ["local", "seen"], ["local", "x"]], ["local", "x"]],
            ["assign", ["local", "x"], 42],
            ["local", "seen"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(42);
    });
    testTest(test, "runs once per set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "x"], 2],
            ["assign", ["local", "x"], 3],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(3);
    });
    testTest(test, "runs even when set to the same value", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 1],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(4);
    });
    testTest(test, "runs before the next statement", (vm, out) => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["always", false, ["print", "watcher"], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["print", "after set"],
        ])).toBeTrue();
        expect(out).toEqual(["watcher", "after set"]);
    });
    testTest(test, "does not run when an unwatched variable is set", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["local", "y"], 5],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "any of multiple watched variables triggers it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "y"]],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "y"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "watching the same variable twice only registers it once", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "all watchers on a variable run", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "a", 0],
            ["letIn", "b", 0],
            ["always", false, ["assign", ["local", "a"], ["add", ["local", "a"], 1]], ["local", "x"]],
            ["always", false, ["assign", ["local", "b"], ["add", ["local", "b"], 10]], ["local", "x"]],
            ["assign", ["local", "x"], 1],
            ["list", ["local", "a"], ["local", "b"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([1, 10]);
    });
    testTest(test, "setting through a deref'd reference triggers it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "rx", ["ref", ["local", "x"]]],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["deref", ["local", "rx"]], 9],
            ["list", ["local", "x"], ["local", "count"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([9, 1]);
    });
    testTest(test, "sets inside a function trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["define", ["bump"], ["assign", ["local", "x"], ["add", ["local", "x"], 1]]],
            ["bump"],
            ["bump"],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(2);
    });
    testTest(test, "watchers can trigger other watchers", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "z", 0],
            ["always", false, ["assign", ["local", "y"], ["add", ["local", "x"], 10]], ["local", "x"]],
            ["always", false, ["assign", ["local", "z"], ["add", ["local", "y"], 100]], ["local", "y"]],
            ["assign", ["local", "x"], 1],
            ["list", ["local", "y"], ["local", "z"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([11, 111]);
    });
    testTest(test, "can watch a variable from a parent scope", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["let", [["f", ["fn", [], ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]]]], ["f"]],
            ["assign", ["local", "x"], 7],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "setting a shadowed variable does not trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["let", [["g", ["fn", [], ["begin", ["letIn", "x", 50], ["assign", ["local", "x"], 51]]]]], ["g"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "defining a constant does not trigger it", vm => {
        expect(run(vm, ["begin",
            ["letIn", "count", 0],
            ["let", [["h", ["fn", [],
                ["letIn", "q", 1],
                ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "q"]],
                ["define", "q", 2],
            ]]], ["h"]],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "can watch through a deref'd stored reference", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "rx", ["ref", ["local", "x"]]],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["deref", ["local", "rx"]]],
            ["assign", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "property changes do not trigger it, but reassigning the variable does", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["letIn", "count", 0],
            ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]],
            ["assign", ["index", ["local", "x"], "foo"], 2],
            ["assign", ["local", "x"], { foo: 3 }],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "returned function cancels the watcher", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]],
            ["assign", ["local", "x"], 1],
            [["local", "cancel"]],
            ["assign", ["local", "x"], 2],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(1);
    });
    testTest(test, "cancelling one watcher leaves the others", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "a", 0],
            ["letIn", "b", 0],
            ["letIn", "cancelA", ["always", false, ["assign", ["local", "a"], ["add", ["local", "a"], 1]], ["local", "x"]]],
            ["always", false, ["assign", ["local", "b"], ["add", ["local", "b"], 10]], ["local", "x"]],
            [["local", "cancelA"]],
            ["assign", ["local", "x"], 1],
            ["list", ["local", "a"], ["local", "b"]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([0, 10]);
    });
    testTest(test, "cancelling a multi-variable watcher removes all of its watches", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "y", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"], ["local", "y"]]],
            [["local", "cancel"]],
            ["assign", ["local", "x"], 1],
            ["assign", ["local", "y"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "cancelling twice does not error", vm => {
        expect(run(vm, ["begin",
            ["letIn", "x", 0],
            ["letIn", "count", 0],
            ["letIn", "cancel", ["always", false, ["assign", ["local", "count"], ["add", ["local", "count"], 1]], ["local", "x"]]],
            [["local", "cancel"]],
            [["local", "cancel"]],
            ["assign", ["local", "x"], 1],
            ["local", "count"],
        ])).toBeTrue();
        expect(popData(vm)).toEqual(0);
    });
    testTest(test, "need at least 1 variable", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["blah"]],
        ])).toThrow("need at least 1 variable to watch");
    });
    testTest(test, "watching an undefined variable errors", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["print", "hi"], ["local", "nope"]],
        ])).toThrow('variable "nope" not found');
    });
    testTest(test, "watching a property errors", vm => {
        expect(() => run(vm, ["begin",
            ["letIn", "x", { foo: 1 }],
            ["always", false, ["print", "hi"], ["index", ["local", "x"], "foo"]],
        ])).toThrow("can't watch this slot");
    });
    testTest(test, "watching a non-reference errors", vm => {
        expect(() => run(vm, ["begin",
            ["always", false, ["print", "hi"], 42],
        ])).toThrow("not a reference");
    });
    testTest(test, "errors in the watcher propagate", vm => {
        expect(() => run(vm, ["begin",
            ["letIn", "x", 0],
            ["always", false, ["throw", ["err", "EPANIC", "watcher blew up"]], ["local", "x"]],
            ["assign", ["local", "x"], 1],
        ])).toThrow("watcher blew up");
    });
    testTest(test, "watching a constant errors", vm => {
        expect(() => run(vm, ["begin",
            ["define", "x", 0],
            ["always", false, ["print", "hi"], ["local", "x"]],
        ])).toThrow("can't watch a constant");
    });
});

describe("keyword and splat arguments", () => {
    testTest(test, "kwargs ignore order", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["kw", "y", 2], ["kw", "x", 1]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "splat unpack into positional", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["splat", ["list", 1, 2]]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "kwarg unpack into named parameters", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
            ["pair", ["splat", { x: 1, y: 2 }, true]],
        ])).toBeTrue();
        expect(out).toEqual(["[1,2]"]);
    });

    testTest(test, "order enforced", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["pair", "x", "y"], ["print", ["jsonStringify", ["list", ["local", "x"], ["local", "y"]]]]],
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

    testTest(test, "keyword-only arguments", vm => {
        expect(() => run(vm, ["begin",
            ["define", ["foo", [0, "x"], "y"]],
            ["foo", 1, 2, 3, 4],
        ])).toThrow('missing required keyword-only parameter "y" of function "foo"');
        vm.reset();
        expect(run(vm, ["begin",
            ["define", ["foo", [0, "x"], "y"]],
            ["foo", 1, 2, 3, 4, ["kw", "y", 5]],
        ])).toBeTrue();
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
            ["define", ["foo", ["a", ["local", "x"]]], ["print", ["local", "a"]]],
            ["let", [["x", "hello"]], ["foo"], ["foo", "goodbye"]],
        ])).toBeTrue();
        expect(out).toEqual(["hello", "goodbye"]);
    });
    testTest(test, "spread arguments", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", [0, "x"]], ["print", ["jsonStringify", ["local", "x"]]]],
            ["foo", 1, 2, 3],
            ["foo"]
        ])).toBeTrue();
        expect(out).toEqual(["[1,2,3]", "[]"]);
    });
    testTest(test, "required may follow optional", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["x", 1], "y"], ["print", ["local", "x"], ["local", "y"]]],
            ["foo", 5, 6],
        ])).toBeTrue();
        expect(out).toEqual(["5 6"]);
        expect(() => run(vm, ["foo", 5])).toThrow('missing required parameter "y" of function "foo"');
    });
    testTest(test, "blank uses the default", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["foo", ["x", 1], "y"], ["print", ["local", "x"], ["local", "y"]]],
            ["foo", ["blank"], 6],
        ])).toBeTrue();
        expect(out).toEqual(["1 6"]);
    });
    testTest(test, "blank can't be used outside of normal args", vm => {
        expect(() => run(vm, ["begin",
            ["blank"]
        ])).toThrow("there is no parameter to which a default can be forced here");
    });
    testTest(test, "options", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["f", [{ a: "the option", b: ["local", "y"] }, "x"]], ["print", ["local", "x"]]],
            ["f", 12345],
            ["f", ["option", "a"]]
        ])).toBeTrue();
        expect(out).toEqual(["12345", "the option"]);
        expect(() => run(vm, ["begin",
            ["f", ["option", "b"]],
        ])).toThrow('variable "y" not found');
    });
    testTest(test, "options dynamic", (vm, out) => {
        expect(run(vm, ["begin",
            ["define", ["f", [{ a: "the option", b: ["local", "y"] }, "x"]], ["print", ["local", "x"]]],
            ["letIn", "y", "the y value"],
            ["f", ["option", "b"]],
        ])).toBeTrue();
        expect(out).toEqual(["the y value"]);
    });
    testTest(test, "bad params", vm => {
        expect(() => run(vm, ["define", ["foo", 1], false])).toThrow("arg name not found at position 0");
    });
    testTest(test, "let loop", (vm, out) => {
        expect(run(vm, ["begin",
            ["let", "loop", [["x", 10]],
                ["print", ["local", "x"]],
                ["if", ["greater", ["local", "x"], 0],
                    ["loop", ["sub", ["local", "x"], 1]]]]
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
                ["if", ["greater", ["local", "a"], 1],
                    ["mul", ["factorial", ["sub", ["local", "a"], 1n]], ["local", "a"]],
                    1n]],
            ["factorial", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(factorial(x));
    });
    const MEMOIZE_F = (f: (a: bigint) => bigint) => { const cache: Record<number, bigint> = {}; return (a: bigint) => (cache[a as any] ??= f(a)) }
    const MEMOIZE = ["define", ["memoize", "f"],
        ["let", [["cache", {}]],
            ["fn", ["a"],
                ["let", [["cached", ["index", ["local", "cache"], ["local", "a"]]]],
                    ["if", ["isNil", ["local", "cached"]],
                        ["assign", ["index", ["local", "cache"], ["local", "a"]], ["f", ["local", "a"]]],
                        ["local", "cached"]]]]]
    ];
    const fibonacci = MEMOIZE_F(a => a < 2 ? a : fibonacci(a - 1n) + fibonacci(a - 2n));
    testTest(test, "A000045 (Fibonacci sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "fibonacci", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 2],
                    ["local", "a"],
                    ["add",
                        ["fibonacci", ["sub", ["local", "a"], 1]],
                        ["fibonacci", ["sub", ["local", "a"], 2]]]]]]],
            ["fibonacci", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(fibonacci(x));
    });
    const tribonacci = MEMOIZE_F(a => a < 3 ? [0n, 0n, 1n][a as any]! : tribonacci(a - 1n) + tribonacci(a - 2n) + tribonacci(a - 3n));
    testTest(test, "A000073 (Tribonacci sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "tribonacci", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 3],
                    ["index", ["list", 0, 0, 1], ["local", "a"]],
                    ["add",
                        ["add",
                            ["tribonacci", ["sub", ["local", "a"], 1]],
                            ["tribonacci", ["sub", ["local", "a"], 2]]],
                        ["tribonacci", ["sub", ["local", "a"], 3]]]]]]],
            ["tribonacci", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(tribonacci(x));
    });
    const q = MEMOIZE_F(a => a < 3 ? 1n : q(a - q(a - 1n)) + q(a - q(a - 2n)));
    testTest(test, "A005185 (Hofstadter 'Q' sequence)", vm => {
        const x = 5000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "q", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 3],
                    1,
                    ["add",
                        ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 1]]]],
                        ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 2]]]]]]]]],
            ["q", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(Number(q(x)));
    });
    const collatz = MEMOIZE_F(a => a < 2 ? 0n : 1n + (a & 1n ? collatz(1n + 3n * a) : collatz(a >> 1n)));
    testTest(test, "A006577 (Collatz conjecture)", vm => {
        const x = 50000000000n;
        expect(run(vm, ["begin",
            MEMOIZE,
            ["define", "collatz", ["memoize", ["fn", ["a"],
                ["if", ["less", ["local", "a"], 2],
                    0,
                    ["add",
                        1,
                        ["if", ["bitAnd", ["local", "a"], 1],
                            ["collatz", ["add", 1, ["mul", 3, ["local", "a"]]]],
                            ["collatz", ["shr", ["local", "a"], 1]]]]]]]],
            ["collatz", x]
        ], undefined, 10000000)).toBeTrue();
        expect(popData(vm)).toEqual(Number(collatz(x)));
    });
    const A063510 = (a: number): number => a < 2 ? 1 : 1 + A063510(a ** 0.5 | 0);
    testTest(test, "A063510", vm => {
        const x = 1e20;
        expect(run(vm, ["begin",
            ["define", ["A063510", "a"],
                ["if", ["less", ["local", "a"], 2],
                    1,
                    ["add", 1, ["A063510", ["bitOr", 0, ["pow", ["local", "a"], 0.5]]]]]],
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
                            return ["local", x];
                        case ".":
                            return ["fn", ["x"], ["out", next()], ["local", "x"]];
                        default:
                            throw "invalid character " + x;
                    }
                }
                expect(run(vm, ["begin",
                    ["define", ["out", "c"], [(c: string) => { out += c; if (autostop && out.length === expectedOutput.length) vm.commandStack = null; }, ["local", "c"]]],
                    ["define", ["s", "x"], ["fn", ["y"], ["fn", ["z"], [["x", ["local", "z"]], ["y", ["local", "z"]]]]]],
                    ["define", ["k", "x"], ["fn", ["_"], ["local", "x"]]],
                    ["define", ["i", "x"], ["local", "x"]],
                    ["define", ["v", "x"], ["local", "v"]],
                    ["define", ["r", "x"], ["out", "\n"], ["local", "x"]],
                    ["define", ["d", [false, "x"]], ["fn", ["y"], [["x"], ["local", "y"]]]],
                    ["define", ["c", "x"], ["x", ["local", "return"]]],
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
                [["index", ["local", "x"], "b"]]]
        ])).toBeTrue();
        expect(popData(vm)).toEqual(42);
    });
    testTest(test, "FFI function callbacks", (vm, out) => {
        const thrice = (f: (x: string) => void, x: string) => (f(x), f(x), f(x));
        expect(() => run(vm, ["begin",
            ["let", [["x", ["fn", ["x"], ["print", ["local", "x"]]]]],
                [thrice, ["local", "x"], "hi"],
                [thrice, ["local", "x"], "bye"]]
        ])).toThrow("cannot call JEB fn");
        // expect(out).toEqual(["hi", "hi", "hi", "bye", "bye", "bye"]);
    });
});

describe("audit hook protections", () => {
    testTest(test, "prevents accessing Function", vm => {
        vm.on("jeb:ffi/object/get", ([key, obj]) => {
            if (obj[key] === Function) {
                throw new JEBError(ErrnoCode.EACCES, "can't access that!");
            }
        });
        expect(() => run(vm, ["index", ["index", {}, "constructor"], "constructor"])).toThrow("can't access that!");
    });
    testTest(test, "infinite loop guard", vm => {
        vm.on("jeb:loop_check", count => {
            if (count > 10000) {
                throw new JEBError(ErrnoCode.EPROCLIM, "too many loops");
            }
        });
        expect(() => run(vm, [
            ["let", "loop", [], ["loop"]]
        ], 10000000)).toThrow("too many loops");
    });
});

describe("location tracking", () => {
    testTest(test, "tracks locations", vm => {
        expect.assertions(7);
        try {
            run(vm, ["at", [0, 0], ["begin",
                ["define", ["f"], ["at", [1, 0], ["g"]]],
                ["define", ["g"], ["at", [2, 0], ["h"]]],
                ["define", ["h"], ["at", [3, 0], ["error"]]],
                ["at", [4, 0], ["f"]],
            ]]);
        } catch (e2: any) {
            const e: JEBError = e2;
            expect(e).toBeInstanceOf(JEBError);
            expect(e.traceback).toBeDefined();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 0)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 1)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 2)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 3)).toBeTrue();
            expect(e.traceback!.some(e => e.leaf && e.location![0] === 4)).toBeTrue();
        }
    });
    testTest(test, "gets parameter blame from callsites", vm => {
        define(vm, "where", makeJSFun("where", ["x"], args => argumentLocation(args, "x"), "test where"));
        expect(run(vm, ["begin",
            ["define", ["id", "x"], ["local", "x"]],
            ["where", ["at", [7, 0], ["id", 42]]],
        ])).toBeTrue();
        expect(popData(vm)).toEqual([7, 0]);
        // an argument that makes no call to at() records no location
        expect(run(vm, ["where", 42])).toBeTrue();
        expect(popData(vm)).toBeUndefined();
        expect(run(vm, ["where", ["at", [9, 0], 42]])).toBeTrue();
        expect(popData(vm)).toEqual([9, 0]);
    });
    testTest(test, "errors can blame a parameter", vm => {
        define(vm, "needs-string", makeJSFun("needs-string", ["x"], args => {
            typecheck(args.x, ["string"], "x", args);
            return args.x;
        }, "test needs-string"));
        expect.assertions(10);
        try {
            run(vm, ["begin",
                ["define", ["id", "x"], ["local", "x"]],
                ["at", [3, 0], ["needs-string", ["at", [7, 0], ["id", 42]]]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("expected string but got number: 42");
            expect(e.paramLocation).toEqual([7, 0]);
            // a frame for the parameter sits on top, at the argument's
            // location; the call's own frame below it keeps the call's
            const first = e.traceback[0];
            expect(first.leaf).toBeTrue();
            expect(first.name).toEqual("x");
            expect(first.kind).toEqual(StackEntryKind.PARAMETER);
            expect(first.location).toEqual([7, 0]);
            const second = e.traceback[1];
            expect(second.leaf).toBeTrue();
            expect(second.name).toEqual("needs-string");
            expect(second.kind).toEqual(StackEntryKind.FUNCTION);
            expect(second.location).toEqual([3, 0]);
        }
    });
    testTest(test, "builtin errors also blame the offending arg", vm => {
        expect.assertions(6);
        try {
            run(vm, ["begin",
                ["define", ["id", "x"], ["local", "x"]],
                ["define", ["f", "x"], ["local", "x"]],
                ["f", ["kw", "x", 1], ["at", [7, 0], ["id", 2]]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("positional argument can't follow keyword argument");
            expect(e.paramLocation).toEqual([7, 0]);
            const first = e.traceback[0];
            expect(first.leaf).toBeTrue();
            expect(first.name).toBeUndefined();
            expect(first.kind).toEqual(StackEntryKind.PARAMETER);
            expect(first.location).toEqual([7, 0]);
        }
    });
    testTest(test, "error blame can go through the default", vm => {
        define(vm, "needs-string", makeJSFun("needs-string", [["x", ["at", [7, 0], ["local", "hello"]]]], args => {
            typecheck(args.x, ["string"], "x", args);
            return args.x;
        }, "test needs-string"));
        expect.assertions(10);
        try {
            run(vm, ["begin",
                ["define", "hello", 42],
                ["at", [3, 0], ["needs-string"]],
            ]);
        } catch (e: any) {
            expect(e.message).toBe("expected string but got number: 42");
            expect(e.paramLocation).toEqual([7, 0]);
            const first = e.traceback[0];
            expect(first.leaf).toBeTrue();
            expect(first.name).toEqual("x");
            expect(first.kind).toEqual(StackEntryKind.PARAMETER);
            expect(first.location).toEqual([7, 0]);
            const second = e.traceback[1];
            expect(second.leaf).toBeTrue();
            expect(second.name).toEqual("needs-string");
            expect(second.kind).toEqual(StackEntryKind.FUNCTION);
            expect(second.location).toEqual([3, 0]);
        }
    });
});

testTest(test, "async test", async vm => {
    const TIME = 1000;
    const a = Date.now();
    expect(await runAsync(vm, [
        makeJSFun("wait", ["time"], ({ time }, vm) =>
            promisifyVM(vm, new Promise(resolve =>
                setTimeout(resolve, withType(time, ["number"], "time")))), ""),
        TIME])).toBeTrue();
    const b = Date.now();
    expect(Math.abs(b - a - TIME)).toBeLessThan(10);
});

testTest(test, "names stick on functions", vm => {
    expect(run(vm, ["begin",
        ["letIn", "foo", ["fn", []], "bar", null],
        ["assign", ["local", "bar"], ["local", "foo"]],
        ["local", "bar"],
    ])).toBeTrue();
    const i = popData(vm);
    expect(i).toBeInstanceOf(Fun);
    expect(i.name).toEqual("foo");
});

describe("protocol methods", () => {
    testTest(test, "__call__ enables calling", vm => {
        expect(run(vm, ["define", "c", {
            n: 5,
            [Symbol.for("__call__")]: ["fn", ["self", "x"], ["add", ["index", ["local", "self"], "n"], ["local", "x"]]],
        }])).toBeTrue();
        expect(run(vm, [["local", "c"], 37])).toBeTrue();
        expect(popData(vm)).toBe(42);
    });
    testTest(test, "operator overloading", vm => {
        expect(run(vm, ["define", "vec", {
            [Symbol.for("__add__")]: ["fn", ["self", "other"], ["add", ["local", "other"], 100]],
            [Symbol.for("__bitNot__")]: ["fn", ["self"], 42],
            [Symbol.for("__neg__")]: ["fn", ["self"], -1],
        }])).toBeTrue();
        expect(run(vm, ["add", ["local", "vec"], 1])).toBeTrue();
        expect(popData(vm)).toBe(101);
        // the unary form of sub dispatches to __neg__
        expect(run(vm, ["sub", ["local", "vec"]])).toBeTrue();
        expect(popData(vm)).toBe(-1);
        expect(run(vm, ["bitInv", ["local", "vec"]])).toBeTrue();
        expect(popData(vm)).toBe(42);
        // an object without the method gets the usual no-overload error
        expect(() => run(vm, ["add", ["object"], 1])).toThrow("No overload of add exists for types object, number");
    });
    testTest(test, "comparison overloading", vm => {
        expect(run(vm, ["define", "o", {
            [Symbol.for("__cmp__")]: ["fn", ["self", "other", "rel"], 42],
        }])).toBeTrue();
        expect(run(vm, ["eq", ["local", "o"], 1])).toBeTrue();
        expect(popData(vm)).toBe(42);
        expect(run(vm, ["less", ["local", "o"], 1])).toBeTrue();
        expect(popData(vm)).toBe(42);
    });
    testTest(test, "descriptor object", vm => {
        vm.currentEnv.add("stored", 7);
        const cellCode = {
            [Symbol.for("__get__")]: ["fn", ["self"], ["local", "stored"]],
            [Symbol.for("__set__")]: ["fn", ["self", "v"], ["assign", ["local", "stored"], ["local", "v"]]],
        };
        expect(run(vm, ["define", "cell", cellCode])).toBeTrue();
        expect(run(vm, ["local", "cell"])).toBeTrue();
        const cell = popData(vm);
        // read through the get opcode
        pushData(vm, cell);
        pushCommand(vm, OP_get, false);
        while (vm.step());
        expect(popData(vm)).toBe(7);
        // assign through the assign opcode: the value stays on the stack
        pushData(vm, 42);
        pushData(vm, cell);
        pushCommand(vm, OP_set);
        while (vm.step());
        expect(popData(vm)).toBe(42);
        expect(run(vm, ["deref", ["local", "cell"]])).toBeTrue();
        expect(popData(vm)).toBe(42);
        // the assign builtin also accepts a bare descriptor object
        expect(run(vm, ["assign", cellCode, 9])).toBeTrue();
        expect(popData(vm)).toBe(9);
        expect(run(vm, ["local", "stored"])).toBeTrue();
        expect(popData(vm)).toBe(9);
        // and ref returns a descriptor as-is (it is its own reference)
        expect(run(vm, ["ref", cellCode])).toBeTrue();
        expect(popData(vm)[Symbol.for("__get__")]).toBeInstanceOf(Fun);
    });
    testTest(test, "no __access__ falls back", vm => {
        expect(run(vm, ["define", ["makePlain"], ["begin",
            ["define", "c", ["object",
                ["sym", "__get__"], ["fn", ["self", "k"], 1],
                ["sym", "__set__"], ["fn", ["self", "k", "v"], 2],
            ]],
            ["local", "c"],
        ]])).toBeTrue();
        // the object is indexed as an ordinary object: __get__ is just a
        // property (reading it gives the method itself), and other fields
        // read and assign as plain properties -- the methods never run
        expect(run(vm, ["define", "c", [["local", "makePlain"]]])).toBeTrue();
        expect(run(vm, ["index", ["local", "c"], ["sym", "__get__"]])).toBeTrue();
        expect(popData(vm)).toBeInstanceOf(Fun);
        expect(run(vm, ["index", ["local", "c"], "x"])).toBeTrue();
        expect(popData(vm)).toBeUndefined();
        expect(run(vm, ["assign", ["index", ["local", "c"], "x"], 5])).toBeTrue();
        expect(run(vm, ["index", ["local", "c"], "x"])).toBeTrue();
        expect(popData(vm)).toBe(5);
    });
    testTest(test, "__access__ should return descriptor", vm => {
        expect(run(vm, ["define", ["makeAccessed"], ["begin",
            ["define", "data", ["object"]],
            ["object",
                ["sym", "__access__"], ["fn", ["self", "k"], ["object",
                    ["sym", "__get__"], ["fn", ["s"], ["index", ["local", "data"], ["local", "k"]]],
                    ["sym", "__set__"], ["fn", ["s", "v"], ["assign", ["index", ["local", "data"], ["local", "k"]], ["local", "v"]]],
                ]],
            ],
        ]])).toBeTrue();
        expect(run(vm, ["define", "c", ["makeAccessed"]])).toBeTrue();
        expect(run(vm, ["assign", ["index", ["local", "c"], "x"], 5])).toBeTrue();
        expect(popData(vm)).toBe(5);
        expect(run(vm, ["index", ["local", "c"], "x"])).toBeTrue();
        expect(popData(vm)).toBe(5);
        // a stored reference accesses through __access__ when it is used
        expect(run(vm, ["define", "r", ["ref", ["index", ["local", "c"], "x"]]])).toBeTrue();
        popData(vm);
        expect(run(vm, ["deref", ["local", "r"]])).toBeTrue();
        expect(popData(vm)).toBe(5);
        // a descriptor without __get__ cannot be read and without __set__ cannot be written
        expect(run(vm, ["define", "bad", {
            [Symbol.for("__access__")]: ["fn", ["self", "k"], ["object"]],
        }])).toBeTrue();
        expect(() => run(vm, ["index", ["local", "bad"], "x"])).toThrow("property is not readable");
        vm.commandStack = null;
        vm.error = undefined;
        expect(() => run(vm, ["assign", ["index", ["local", "bad"], "x"], 1])).toThrow("descriptor is not writable");
    });
    testTest(test, "__access__ decides whether the key is evaluated", vm => {
        vm.currentEnv.add("count", 0);
        expect(run(vm, ["define", ["bump"], ["begin",
            ["assign", ["local", "count"], ["add", ["local", "count"], 1]],
            99,
        ]])).toBeTrue();
        // a lazy key parameter: the key expression never runs
        expect(run(vm, ["define", "lazyTracker", {
            [Symbol.for("__access__")]: ["fn", ["self", [false, "k"]], ["object",
                ["sym", "__get__"], ["fn", ["s"], "seen"],
            ]],
        }])).toBeTrue();
        expect(run(vm, ["index", ["local", "lazyTracker"], ["bump"]])).toBeTrue();
        expect(popData(vm)).toBe("seen");
        expect(run(vm, ["local", "count"])).toBeTrue();
        expect(popData(vm)).toBe(0);
        // a normal key parameter: the key is evaluated and passed in
        expect(run(vm, ["define", "eagerTracker", {
            [Symbol.for("__access__")]: ["fn", ["self", "k"], ["object",
                ["sym", "__get__"], ["fn", ["s"], ["local", "k"]],
            ]],
        }])).toBeTrue();
        expect(run(vm, ["index", ["local", "eagerTracker"], ["bump"]])).toBeTrue();
        expect(popData(vm)).toBe(99);
        expect(run(vm, ["local", "count"])).toBeTrue();
        expect(popData(vm)).toBe(1);
    });
    testTest(test, "__access__ descriptor's __set__ decides whether the value is evaluated", vm => {
        vm.currentEnv.add("count", 0);
        expect(run(vm, ["define", ["bump"], ["begin",
            ["assign", ["local", "count"], ["add", ["local", "count"], 1]],
            99,
        ]])).toBeTrue();
        expect(run(vm, ["define", "sink", {
            [Symbol.for("__access__")]: ["fn", ["self", "k"], ["object",
                ["sym", "__set__"], ["fn", ["s", [false, "v"]], 12345],
            ]],
        }])).toBeTrue();
        // the lazy __set__ never evaluates the right-hand side, and the
        // assignment returns the method's own result
        expect(run(vm, ["assign", ["index", ["local", "sink"], "k"], ["bump"]])).toBeTrue();
        expect(popData(vm)).toBe(12345);
        expect(run(vm, ["local", "count"])).toBeTrue();
        expect(popData(vm)).toBe(0);
    });
    testTest(test, "lazy __set__ and __call__: the hole never evaluates what it ignores", vm => {
        vm.currentEnv.add("count", 0);
        expect(run(vm, ["define", ["bump"], ["begin",
            ["assign", ["local", "count"], ["add", ["local", "count"], 1]],
            99,
        ]])).toBeTrue();
        expect(run(vm, ["define", "hole", {
            [Symbol.for("__access__")]: ["fn", ["self", "k"], ["local", "self"]],
            [Symbol.for("__get__")]: ["fn", ["self"], ["local", "self"]],
            [Symbol.for("__set__")]: ["fn", ["self", [false, "v"]], ["local", "self"]],
            [Symbol.for("__call__")]: ["fn", ["self", [false, "a"]], ["local", "self"]],
        }])).toBeTrue();
        expect(run(vm, ["local", "hole"])).toBeTrue();
        const hole = popData(vm);
        // calling the hole does not evaluate the argument, and returns the hole
        expect(run(vm, [["local", "hole"], ["bump"]])).toBeTrue();
        expect(popData(vm)).toBe(hole);
        // indexing the hole returns the hole
        expect(run(vm, ["index", ["local", "hole"], "x"])).toBeTrue();
        expect(popData(vm)).toBe(hole);
        // assigning to the hole does not evaluate the right-hand side, and returns the hole
        expect(run(vm, ["assign", ["index", ["local", "hole"], "x"], ["bump"]])).toBeTrue();
        expect(popData(vm)).toBe(hole);
        expect(run(vm, ["local", "count"])).toBeTrue();
        expect(popData(vm)).toBe(0);
    });
    testTest(test, "a callable object can serve as a protocol method", vm => {
        // the __access__ "method" stored on this object is itself an
        // object, callable through its own __call__ (whose parameters are
        // the method object, then the indexed object, then the key)
        expect(run(vm, ["define", "o", ["object",
            ["sym", "__access__"], ["object",
                ["sym", "__call__"], ["fn", ["self", "owner", "k"], ["object",
                    ["sym", "__get__"], ["fn", ["d"], ["local", "k"]],
                ]],
            ],
        ]])).toBeTrue();
        expect(run(vm, ["index", ["local", "o"], "hello"])).toBeTrue();
        expect(popData(vm)).toBe("hello");
        // and an object whose __call__ is a callable object can be called
        expect(run(vm, ["define", "doubler", ["object",
            ["sym", "__call__"], ["object",
                ["sym", "__call__"], ["fn", ["self", "obj", "x"],
                    ["add", ["local", "x"], ["local", "x"]]],
            ],
        ]])).toBeTrue();
        expect(run(vm, [["local", "doubler"], 21])).toBeTrue();
        expect(popData(vm)).toBe(42);
    });
    testTest(test, "curried methods forward defaults and rest arguments", vm => {
        // y's default mentions the receiver: it must still find it after
        // the receiver is curried away
        expect(run(vm, ["define", "o", ["object",
            "inc", 10,
            ["sym", "__call__"], ["fn",
                ["self", "x", ["y", ["index", ["local", "self"], "inc"]]],
                ["local", "y"]],
        ]])).toBeTrue();
        expect(run(vm, [["local", "o"], 1])).toBeTrue();
        expect(popData(vm)).toBe(10);
        expect(run(vm, [["local", "o"], 1, 5])).toBeTrue();
        expect(popData(vm)).toBe(5);
        // a positional rest parameter forwards through a splat
        expect(run(vm, ["define", "o2", ["object",
            ["sym", "__call__"], ["fn", ["self", "x", [0, "rest"]],
                ["index", ["local", "rest"], 1]],
        ]])).toBeTrue();
        expect(run(vm, [["local", "o2"], 0, 20, 30])).toBeTrue();
        expect(popData(vm)).toBe(30);
        // and a keyword rest parameter forwards as keyword arguments
        expect(run(vm, ["define", "o3", ["object",
            ["sym", "__call__"], ["fn", ["self", [1, "kw"]],
                ["index", ["local", "kw"], "bonus"]],
        ]])).toBeTrue();
        expect(run(vm, [["local", "o3"], ["kw", "bonus", 7]])).toBeTrue();
        expect(popData(vm)).toBe(7);
    });
    testTest(test, "__name__ method is told the variable's name", vm => {
        vm.currentEnv.add("seen", null);
        expect(run(vm, ["define", "thing", {
            [Symbol.for("__name__")]: ["fn", ["self", "n"], ["assign", ["local", "seen"], ["local", "n"]]],
        }])).toBeTrue();
        expect(run(vm, ["local", "seen"])).toBeTrue();
        expect(popData(vm)).toBe("thing");
    });
    testTest(test, "__unwrap__ method unwraps a wrapper with no dedicated unwrapper", vm => {
        class TestWrapper extends Wrapper {
            flag = "test";
            constructor(obj: any) {
                super(obj);
                (this as any)[Symbol.for("__unwrap__")] = makeJSFun("unwrapTest", ["self"], () => 123, "test unwrapper");
            }
        }
        pushData(vm, new TestWrapper(0));
        pushCommand(vm, OP_unwrap, []);
        while (vm.step());
        expect(popData(vm)).toBe(123);
    });
});

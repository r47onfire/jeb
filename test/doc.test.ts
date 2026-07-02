import { describe, expect, test } from "bun:test";
import { isString } from "lib0/function.js";
import { AccessorParsers, ApplierParsers, DocMetadata, DocMetadataParser, DocNode, EmptyTag, EvaluatorParsers, FunctionOrMacroParsers, JebVM, OpcodeParsers, ParamTag, parseDoc, parseHeaderAndSummary, parseInline, parseParagraphs } from "../src";

describe("inline parsing", () => {
    test.each<[string, string, DocNode[]]>([
        ["blank", "", []],
        ["nothing", "a", ["a"]],
        ["italic", "*a* b", [["i", "a"], " b"]],
        ["bold", "**a** b", [["b", "a"], " b"]],
        ["code", "`a` b", [["c", "a"], " b"]],
        ["nesting 1", "*`a` b*", [["i", ["c", "a"], " b"]]],
        ["nesting 2", "*`*a* b` c", [["i", ["c", ["i", "a"], " b"], " c"]]],
        ["pathological nesting", "***a***b*c**d*e**", [["b", ["i", "a", ["b", ["i", "b"], "c"], "d"], "e"]]],
        ["code does not trump nesting", "`*a* b`", [["c", ["i", "a"], " b"]]],
        ["code can still have escapes inside", "`\\*a\\* b`", [["c", "*a* b"]]],
        ["ref parse 1", "[[abc3!`***$*]]", [["r", "abc3!`***$*"]]],
        ["ref parse 2", "[[ref#path#hash]]", [["r", "ref", undefined, "path#hash"]]],
        ["ref parse 3", "[[ref#group:path]]", [["r", "ref", "group", "path"]]],
        ["ref parse 4", "[[ref:ref]]", [["r", "ref:ref"]]],
        ["ref parse 5", "[[ref:name#group:path#hash]]", [["r", "ref:name", "group", "path#hash"]]],
        ["ref parse inside code", "`(a[[b]])`", [["c", "(a", ["r", "b"], ")"]]],
    ])("%s", (_, input, expected) => {
        expect(parseInline(input)).toEqual(expected);
    });
});

describe("paragraph parsing", () => {
    test.each<[string, string[], DocNode[]]>([
        ["empty", [], []],
        ["blank", [""], [["p"]]],
        ["normal paragraph 1", ["a"], [["p", "a"]]],
        ["normal paragraph 2", ["a", "a"], [["p", "a"], ["p", "a"]]],
        ["bulleted list", ["* a", "* a"], [["u", ["l", null, "a"], ["l", null, "a"]]]],
        ["numbered list", ["1. a", "2. a"], [["o", ["l", 1, "a"], ["l", 2, "a"]]]],
        ["list with paragraphs on one side", ["a", "* a", "* a"], [["p", "a"], ["u", ["l", null, "a"], ["l", null, "a"]]]],
        ["list with paragraphs on both sides", ["a", "* a", "* a", "a"], [["p", "a"], ["u", ["l", null, "a"], ["l", null, "a"]], ["p", "a"]]],
        ["mixed list types", ["* a", "1. a", "* a", "100. a"], [["u", ["l", null, "a"]], ["o", ["l", 1, "a"]], ["u", ["l", null, "a"]], ["o", ["l", 100, "a"]]]]
    ])("%s", (_, input, expected) => {
        expect(parseParagraphs(input)).toEqual(expected);
    });
});

describe("tag parsing ok", () => {
    test.each<[string, string[], Record<string, DocMetadataParser>, DocMetadata[], string[]]>([
        ["no tags", ["a", "b"], {}, [], ["a", "b"]],
        ["single flag tag", [".a", ".a"], { a: EmptyTag }, [{ tag: "a" }, { tag: "a" }], []],
        ["nested tag", [".a", "..a", ".a"], { a: EmptyTag }, [{ tag: "a", groups: [{ tag: "a" }] }, { tag: "a" }], []],
        ["double nested tag", [".a", "..a", "...a", ".a"], { a: EmptyTag }, [{ tag: "a", groups: [{ tag: "a", groups: [{ tag: "a" }] }] }, { tag: "a" }], []],
        ["blank tag to reset", [".a", ". b", "c"], { a: EmptyTag }, [{ tag: "a" }], ["b", "c"]]
    ])("%s", (_, lines, parsers, expectedMeta, expectedRest) => {
        expect(parseHeaderAndSummary(lines, parsers)).toEqual([expectedMeta, expectedRest]);
    });
    describe("param tag", () => {
        test.each<[string, string, DocMetadata]>([
            ["simple param", ".t {a} b - c", { tag: "t", type: "a", name: "b", flags: [], default: undefined, description: [["p", "c"]] }],
            ["optional param", ".t {a} [b=c] - d", { tag: "t", type: "a", name: "b", flags: [], default: "c", description: [["p", "d"]] }],
            ["rest param", ".t {a} b...", { tag: "t", type: "a", name: "b", flags: ["rest"], default: undefined, description: [] }],
            ["lazy param", ".t {a} @b", { tag: "t", type: "a", name: "b", flags: ["lazy"], default: undefined, description: [] }],
            ["lazy rest param", ".t {a} @b...", { tag: "t", type: "a", name: "b", flags: ["lazy", "rest"], default: undefined, description: [] }],
            ["complex type", ".t {(a: b) => c} d - e", { tag: "t", type: "(a: b) => c", name: "d", flags: [], default: undefined, description: [["p", "e"]] }],
            ["union type", ".t {a | [b, c]} d - e", { tag: "t", type: "a | [b, c]", name: "d", flags: [], default: undefined, description: [["p", "e"]] }],
            ["quoted default", ".t {a} [b=\"c\"] - d", { tag: "t", type: "a", name: "b", flags: [], default: "\"c\"", description: [["p", "d"]] }],
            ["name without dash", ".t {a} b c", { tag: "t", type: "a", name: "b", flags: [], default: undefined, description: [["p", "c"]] }],
            ["optional type", ".t a - b", { tag: "t", type: undefined, name: "a", flags: [], default: undefined, description: [["p", "b"]] }],
        ])("%s", (_, line, expectedMeta) => {
            expect(parseHeaderAndSummary([line], { t: ParamTag })).toEqual([[expectedMeta], []]);
        });
    });
});
describe("tag parsing failures", () => {
    test.each<[string, string[], Record<string, DocMetadataParser>, string]>([
        ["undefined tag", [".abc"], {}, `unknown tag "abc"`],
        ["flag tags with content", [".abc test"], { abc: EmptyTag }, "is just a flag and should have no content"],
        [">1 jump in indentation", [".abc", "...abc"], { abc: EmptyTag }, "can only jump one level at a time"],
    ])("%s", (_, lines, parsers, expectedError) => {
        expect(() => parseHeaderAndSummary(lines, parsers)).toThrow(expectedError);
    });
});

describe("parse builtins docstrings", () => {
    describe("opcodes", () => {
        test.each<[string, string]>(Object.entries(new JebVM().opcodeTable).flatMap(([name, [, doc]]) => doc ? [[name, doc]] : []))("%s", (_, doc) => {
            const parsed = parseDoc(doc, OpcodeParsers);
            expect(parsed).toBeDefined();
            expect(parsed!.meta.length).toBeGreaterThan(0);
        });
    });
    describe("functions/macros", () => {
        test.each<[string, string]>(Object.entries(new JebVM().builtinsEnv.bindings).flatMap(([name, item]) => isString(item?.doc) ? [[name, item.doc as string]] : []))("%s", (_, doc) => {
            const parsed = parseDoc(doc, FunctionOrMacroParsers);
            expect(parsed).toBeDefined();
            expect(parsed!.meta.length).toBeGreaterThan(0);
            // console.log(JSON.stringify(parsed!.meta, null, 2));
        });
    });

    describe("appliers", () => {
        test.each<[string, string]>(new JebVM().applyTable.map(({ type, doc }) => [typeof type === "function" ? type.name : (type + ""), doc]))("%s", (_, doc) => {
            const parsed = parseDoc(doc, ApplierParsers);
            expect(parsed).toBeDefined();
            expect(parsed!.body.length).toBeGreaterThan(0);
        });
    });

    describe("evaluators", () => {
        test.each<[string, string]>(new JebVM().evalTable.map(({ type, doc }) => [typeof type === "function" ? type.name : (type + ""), doc]))("%s", (_, doc) => {
            const parsed = parseDoc(doc, EvaluatorParsers);
            expect(parsed).toBeDefined();
            expect(parsed!.body.length).toBeGreaterThan(0);
        });
    });

    describe("accessors", () => {
        test.each<[string, string]>(new JebVM().accessTable.map(({ type, doc }) => [typeof type === "function" ? type.name : (type + ""), doc]))("%s", (_, doc) => {
            const parsed = parseDoc(doc, AccessorParsers);
            expect(parsed).toBeDefined();
            expect(parsed!.body.length).toBeGreaterThan(0);
        });
    });
});

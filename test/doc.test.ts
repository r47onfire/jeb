import { describe, expect, test } from "bun:test";
import { DocMetadata, DocMetadataParser, DocNode, EmptyTag, parseHeader, parseInline, parseParagraphs } from "../src";

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
        ["single flag tag", [".a", ".b"], { a: EmptyTag, b: EmptyTag }, [{ tag: "a" }, { tag: "b" }], []],
        ["nested tag", [".a", "..b", ".c"], { a: EmptyTag, b: EmptyTag, c: EmptyTag }, [{ tag: "a", groups: [{ tag: "b" }] }, { tag: "c" }], []],
    ])("%s", (_, lines, parsers, expectedMeta, expectedRest) => {
        expect(parseHeader(lines, parsers)).toEqual([expectedMeta, expectedRest]);
    });
});
describe("tag parsing failures", () => {
    test.each<[string, string[], Record<string, DocMetadataParser>, string]>([
        ["undefined tag", [".abc"], {}, `unknown tag "abc"`],
        ["flag tags with content", [".abc test"], { abc: EmptyTag }, "is just a flag and should have no content"],
        [">1 jump in indentation", [".abc", "...abc"], { abc: EmptyTag }, "can only jump one level at a time"],
    ])("%s", (_, lines, parsers, expectedError) => {
        expect(() => parseHeader(lines, parsers)).toThrow(expectedError);
    });
});

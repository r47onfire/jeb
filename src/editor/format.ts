import { isArray, last } from "lib0/array";
import { id, isString } from "lib0/function";
import { stringify } from "lib0/json";
import { max } from "lib0/math";
import { Doc, HeaderForm } from "../doc";
import { JebVM } from "../vm";

export type NonterminalPath = (string | number)[];
export type Path = NonterminalPath | [...NonterminalPath, true];
export interface Format {
    sig?: string,
    l1keep?: number;
    indent?: number;
    children?: (Format | null)[];
    flag?: string;
};

interface FatString {
    /** formatted */
    f: string;
    /** unformatted */
    u: string;
}

const fatString = (formatted: string, unformatted: string): FatString => {
    return { f: formatted, u: unformatted };
}

const lastLineWidth = (str: FatString): number => {
    const nlPos = str.u.lastIndexOf("\n");
    if (nlPos > 0) return str.u.length - nlPos - 1;
    return str.u.length;
}

/** string parts are assumed to be unformatted. */
const fatConcat = (...parts: (string | FatString)[]): FatString => {
    var formatted = "";
    var unformatted = "";
    for (var part of parts) {
        if (isString(part)) {
            formatted += part;
            unformatted += part;
        } else {
            formatted += part.f;
            unformatted += part.u;
        }
    }
    return { f: formatted, u: unformatted };
}

export class Formatter {
    prettySyntax = true;

    constructor(
        public vm: JebVM,
        public baseIndent = 2,
        public columns = 100) {
    }
    format(node: any, selector: Path) {
        return this.#superprint(node, null, 0, selector, this.columns, [], null).f;
    }
    getIndent(width: number) {
        return " ".repeat(width);
    }
    highlight(string: string): string {
        return string;
    }
    wrapNode(string: string, flag: string | null): string {
        return string;
    }
    escape(string: string): string {
        return string;
    }
    #escapeString(string: string): string {
        return this.escape(/^((?!\s)[\p{L}\p{N}\p{P}\p{S}\p{C}\p{Z}])*$/u.test(string) ? string : stringify(string).replace(/(?<!\\)\\n/g, "\n"));
    }
    handleAtom(atom: any, isSelected: boolean, flag: string | null, parent: any, parentIndex: number, availableWidth: number) {
        return this.#escapeString(String(atom));
    }
    unFormat(string: string) {
        return string;
    }
    #superprint(
        node: any,
        parent: any,
        parentIndex: number,
        sel: Path,
        availableWidth: number,
        path: Path = [],
        currentFormat: Format | null = null
    ): FatString {
        const indentForm = (width: number) => this.getIndent(max(0, width));
        const pathMatches = (a: Path) => a.length === sel.length && a.every((v, i) => v === sel[i]);
        const hlString = (s: string, flag: string | null, path2 = path) => this.wrapNode(pathMatches(path2) ? this.highlight(s) : s, flag);
        const hlFatString = (s: FatString, flag: string | null, path2 = path) => fatString(this.wrapNode(pathMatches(path2) ? this.highlight(s.f) : s.f, flag), s.u);
        const recur = (n: any, i: number, p: Path, childFmt?: Format | null, width: number = availableWidth) =>
            this.#superprint(n, node, i, sel, width, p, childFmt);

        if (isArray(node)) {
            const fmt = currentFormat ?? this.#getFormat(node);
            const curFlag = fmt?.flag ?? null;
            if (node.length === 0) return fatString(hlString("()", curFlag), "()");

            // sigil like $x 'x `x ,x ,@x
            if (fmt?.sig && this.prettySyntax) {
                const sigPath = [...path as NonterminalPath, 0];
                const childFmt = fmt.children?.[1];
                const sigFmt = this.handleAtom(fmt.sig, pathMatches(sigPath), childFmt?.flag ?? null, node, 0, availableWidth);
                const sigFat: FatString = { f: sigFmt, u: this.unFormat(sigFmt) };
                const childResult = recur(node[1]!, 1, [...path as NonterminalPath, 1],
                    childFmt, availableWidth - sigFat.u.length - 1);
                const combined = hlFatString(
                    fatConcat(hlFatString(sigFat, null, sigPath), childResult),
                    curFlag);
                return indentText(combined, indentForm, fmt.sig.length, false);
            }

            var { l1keep, indent, children = [] } = fmt ?? {};
            indent ||= this.baseIndent;

            if (!l1keep) {
                foo: {
                    var inline = fatString("(", "(");
                    for (var i = 0; i < node.length; i++) {
                        if (i > 0) inline = fatConcat(inline, " ");
                        const childResult = recur(node[i], i, [...path as NonterminalPath, i], children[i], availableWidth - inline.u.length);
                        const nextChunk = indentText(
                            childResult,
                            indentForm,
                            inline.u.length,
                            false);
                        if (/\n/.test(nextChunk.f)) break foo;
                        inline = fatConcat(inline, nextChunk);
                    }
                    inline = fatConcat(inline, ")");
                    if (inline.u.length <= availableWidth) return hlFatString(inline, curFlag);
                }
            }

            l1keep ||= 1;
            var brokenlines = fatString("(", "(");
            for (var i = 0; i < node.length; i++) {
                if (i >= l1keep) brokenlines = fatConcat(brokenlines, "\n");
                else if (i > 0) brokenlines = fatConcat(brokenlines, " ");

                const curLineWidth = lastLineWidth(brokenlines);
                const rendered = recur(node[i]!, i, [...path as NonterminalPath, i], children[i], availableWidth - (i >= l1keep! ? indent! : curLineWidth));

                if (i >= l1keep) {
                    brokenlines = fatConcat(brokenlines, rendered);
                } else {
                    const indented = indentText(rendered, indentForm, curLineWidth, false);
                    brokenlines = fatConcat(brokenlines, indented);
                }

                if (/\n/.test(rendered.f) && l1keep > 0) {
                    l1keep = 0;
                }
            }
            brokenlines = fatConcat(brokenlines, ")");

            if (fmt) {
                const indented = indentText(brokenlines, indentForm, indent, false);
                return hlFatString(indented, curFlag);
            } else {
                return hlFatString(brokenlines, curFlag);
            }
        }

        if (node && typeof node === "object") {
            const { flag: curFlag = null, children = [] } = currentFormat ?? {};
            const parts = Object.entries(node).map(([k, v], i) => {
                const keyPath: Path = [...path as NonterminalPath, k, true];
                const keyStr = this.#escapeString(k);
                const keyMatched = pathMatches(keyPath);
                const renderedKey = (keyMatched ? (s: string) => this.highlight(s) : id)(this.handleAtom(keyStr, keyMatched, curFlag, node, i, availableWidth - 1));
                const keyLen = this.unFormat(renderedKey).length;
                const valueCol = keyLen + 2;
                const val = recur(v, i, [...path as NonterminalPath, k], children[i] ?? children[k as any], availableWidth - valueCol);
                const indentedVal = indentText(val, indentForm, valueCol, false);
                return fatConcat(renderedKey, ": ", indentedVal);
            });

            var strLong = fatString("{", "{"), strSameline = strLong;
            for (var i = 0; i < parts.length; i++) {
                if (i > 0) {
                    strLong = fatConcat(strLong, ",\n");
                    strSameline = fatConcat(strSameline, ", ");
                }
                const s = parts[i]!;
                const indentedLong = indentText(s, indentForm, 1, i > 0);
                strLong = fatConcat(strLong, indentedLong);
                strSameline = fatConcat(strSameline, s);
            }
            strLong = fatConcat(strLong, "}");
            strSameline = fatConcat(strSameline, "}");


            if (strSameline.u.length > availableWidth || /\n/.test(strSameline.u)) {
                return hlFatString(strLong, curFlag);
            }
            return hlFatString(strSameline, curFlag);
        }

        const flag = currentFormat?.flag ?? null;
        const atom = this.handleAtom(node, pathMatches(path), flag, parent, parentIndex, availableWidth);
        return fatString(hlString(atom, flag), this.unFormat(atom));
    }
    #getFormat(form: any[]): Format | null {
        const name = form[0];
        if (!name) return null;
        const { value } = this.vm.globalEnv.get(name);
        if (!(value.doc)) return null;
        const headerForms = (value.doc as Doc).headerData;
        var breakage: Format | null = null;
        for (var headerForm of headerForms) {
            if (headerForm.matches(form)) {
                const b = getBreakage(headerForm, form);
                // Sigil form takes priority
                if (b?.sig) return b;
                else breakage ??= b;
            }
        }
        return breakage;
    }
};



const indentText = (fs: FatString, form: (width: number) => string, indent: number, indentFirst: boolean): FatString => {
    const indentStr = form(indent);

    const indentInner = (s: string) => s.split("\n").map((line, i) => (indentFirst || i > 0 ? indentStr + line : line).trimEnd()).join("\n");
    const newFormatted = indentInner(fs.f);
    const newUnformatted = indentInner(fs.u);

    return { f: newFormatted, u: newUnformatted };
};

export const getBreakage = (header: HeaderForm, form: any): Format | null => {
    const { spec, placeholders, actions, flags } = header;
    var sig;
    if (spec.length === 2 && /^[\p{P}\p{S}\p{C}\p{Z}]+$/u.test(spec[0])) sig = spec[0];
    // Calculate breakage
    const recur = (spec: any[], form: any[]): Format => {
        var l1keep, indent, children: Format[] = [];
        const end = last(spec);
        const p = placeholders.get(end);
        if (p) {
            const action = actions.get(p);
            if (p.endsWith("...")) {
                l1keep = spec.length - 1;
            }
            if (action === "sameline") {
                l1keep = Infinity;
            }
            else if (action === "eachline") {
                l1keep = indent = 1;
            }
        }
        for (var i = 1; i < spec.length; i++) {
            const f = spec[i]!;
            const action = actions.get(placeholders.get(f)!);
            if (action === "newline") {
                if (l1keep !== 1 && l1keep !== Infinity) {
                    l1keep = i;
                }
                break;
            }
        }
        for (var i = 0; i < spec.length; i++) {
            const p = spec[i]!;
            if (isString(p)) {
                const flag = flags.get(placeholders.get(p)!);
                if (flag) {
                    // Kludge... hmmm.
                    // TODO: more control codes in the docstring to control this
                    // TODO: 'quote' code that goes recursively
                    if (flag === "let") {
                        for (var j = i; j < form.length; j++) {
                            children[j] = { l1keep: 2, children: [{ flag: "defvar" }] };
                        }
                    }
                    else if (flag === "lambda") {
                        for (var j = i; j < form.length; j++) {
                            children[j] = { flag: "defvar" };
                        }
                    }
                    else children[i] = { flag };
                }
            }
            else if (isArray(p)) children[i] = recur(p, form?.[i]);
        }
        return { l1keep, indent, children };
    };
    const res = recur(spec, form);
    if (sig) res.sig = sig;
    return res;
};

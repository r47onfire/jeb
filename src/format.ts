import { isArray } from "lib0/array";
import { undefinedToNull } from "lib0/conditions";
import { stringify } from "lib0/json";
import { max } from "lib0/math";
import { getBreakage, HasDocstring } from "./doc";
import { JebVM } from "./vm";

type Path = (string | number | boolean)[];
export interface Format {
    sig?: string,
    l1keep?: number;
    indent?: number;
    children?: (Format | null)[];
    flag?: string;
};

export class Formatter {
    prettySyntax = true;

    constructor(
        public vm: JebVM,
        public baseIndent = 2,
        public maxWidth = 100) {
    }
    format(node: any, selector: Path) {
        return this.#superprint(node, null, 0, selector, this.maxWidth, [], null);
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
    ): string {
        const indentForm = (width: number) => this.getIndent(width);
        const pathMatches = (a: Path) => a.length === sel.length && a.every((v, i) => v === sel[i]);
        const hlWrapper = (s: string, flag: string | null) => this.wrapNode(pathMatches(path) ? this.highlight(s) : s, flag);
        const recur = (n: any, i: number, p: Path, childFmt?: Format | null, width: number = availableWidth) =>
            this.#superprint(n, node, i, sel, width, p, childFmt);

        if (isArray(node)) {
            const fmt = currentFormat ?? this.#getFormat(node);
            const curFlag = undefinedToNull(fmt?.flag);
            if (node.length === 0) return hlWrapper("()", curFlag);

            // sigil like $x 'x `x ,x ,@x
            if (fmt?.sig && this.prettySyntax) {
                const sigMatch = pathMatches([...path, 0]);
                const childFmt = fmt.children?.[1];
                const sigFmt = this.handleAtom(fmt.sig, sigMatch, childFmt?.flag ?? null, node, 0, availableWidth);
                return indentText(
                    hlWrapper(sigMatch
                        ? this.highlight(sigFmt)
                        : sigFmt + recur(node[1]!, 1, [...path, 1],
                            childFmt, availableWidth - this.unFormat(sigFmt).length - 1),
                        curFlag),
                    indentForm,
                    fmt.sig.length,
                    false);
            }

            var { l1keep, indent, children = [] } = fmt ?? {};
            indent ||= this.baseIndent;

            foo: {
                if (!l1keep) {
                    var inline = "(";
                    for (var i = 0; i < node.length; i++) {
                        if (i > 0) inline += " ";
                        const strippedStr = this.unFormat(inline);
                        const nextChunk = indentText(
                            recur(node[i], i, [...path, i], children[i], availableWidth - strippedStr.length),
                            indentForm,
                            strippedStr.length,
                            false);
                        if (/\n/.test(nextChunk)) break foo;
                        inline += nextChunk;
                    }
                    inline += ")";
                    if (this.unFormat(inline).length <= availableWidth) return hlWrapper(inline, curFlag);
                }
            }

            l1keep ||= 1;
            var inline = "(";
            for (var i = 0; i < node.length; i++) {
                if (i >= l1keep) inline += "\n";
                else if (i > 0) inline += " ";
                const strippedStr = this.unFormat(inline);
                const curLineWidth = strippedStr.length - max(strippedStr.lastIndexOf("\n"), 0) - indent;
                const render = () => recur(node[i]!, i, [...path, i], children[i],
                    availableWidth - (i >= l1keep! ? indent! : curLineWidth));
                var rendered = render();
                inline += i >= l1keep
                    ? rendered
                    : indentText(rendered, indentForm, curLineWidth, false);
                if (/\n/.test(rendered) && l1keep > 0) {
                    l1keep = 0;
                }
            }
            inline += ")";
            return hlWrapper(indentText(inline, indentForm, indent, false), curFlag);
        }

        if (node && typeof node === "object") {
            const { flag: curFlag = null, children = [] } = currentFormat ?? {};
            const parts = Object.entries(node).map(([k, v], i) => {
                const keyPath: Path = [...path, k, true];
                const keyStr = this.#escapeString(k);
                const renderedKey = this.handleAtom(keyStr, pathMatches(keyPath), curFlag, node, i, availableWidth - 1);
                const valueCol = this.unFormat(renderedKey).length + 2;
                const val = recur(v, i, [...path, k], children[i] ?? children[k as any], availableWidth - valueCol);
                return `${renderedKey}: ${indentText(val, indentForm, valueCol, false)}`;
            });

            var strLong = "{", strSameline = strLong;
            for (var i = 0; i < parts.length; i++) {
                if (i > 0) {
                    strLong += ",\n";
                    strSameline += ", ";
                }
                const s = parts[i]!;
                strLong += indentText(s, indentForm, 1, i > 0);
                strSameline += s;
            }
            strLong += "}";
            strSameline += "}";
            if (this.unFormat(strSameline).length > availableWidth || /\n/.test(strSameline)) return hlWrapper(strLong, curFlag);
            return hlWrapper(strSameline, curFlag);
        }

        const flag = undefinedToNull(currentFormat?.flag);
        return hlWrapper(this.handleAtom(node, pathMatches(path), flag, parent, parentIndex, availableWidth), flag);
    }
    #getFormat(form: any[]): Format | null {
        const name = form[0];
        if (!name) return null;
        const { value } = this.vm.globalEnv.get(name);
        if (!(value instanceof HasDocstring)) return null;
        const headerForms = value.doc.headerData;
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



function indentText(text: string, form: (width: number) => string, indent: number, indentFirst: boolean): string {
    return text.split("\n").map((line, i) => (indentFirst || i > 0 ? (form(indent) + line) : line).trimEnd()).join("\n");
}
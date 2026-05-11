import { isArray } from "lib0/array";
import { isString } from "lib0/function";
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
    highlight(string: string, isAtom: boolean): string {
        return string;
    }
    escape(string: string): string {
        return string;
    }
    #escapeString(string: string): string {
        return this.escape(/^[\p{L}\p{N}\p{P}\p{S}\p{C}\p{Z}]*$/u.test(string) ? string : stringify(string).replace(/(?<!\\)\\n/g, "\n"));
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
        const hlWrapper = (s: string, isAtom: boolean) => pathMatches(path) ? this.highlight(s, isAtom) : s;
        const recur = (n: any, i: number, p: Path, childFmt?: Format | null, width: number = availableWidth) =>
            this.#superprint(n, node, i, sel, width, p, childFmt);

        if (isArray(node)) {
            if (node.length === 0) return hlWrapper("()", true);

            const fmt = currentFormat ?? this.#getFormat(node);

            // sigil like $x 'x `x ,x ,@x
            if (fmt?.sig) {
                const sigMatch = pathMatches([...path, 0]);
                const childFmt = fmt.children?.[1];
                const sigFmt = this.handleAtom(fmt.sig, sigMatch, childFmt?.flag ?? null, node, 0, availableWidth);
                return indentText(
                    hlWrapper(sigMatch ? this.highlight(sigFmt, true) : sigFmt + recur(node[1]!, 1, [...path, 1], childFmt, availableWidth - this.unFormat(sigFmt).length), false),
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
                    if (this.unFormat(inline).length <= availableWidth) return hlWrapper(inline, false);
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
                if (/\n/.test(rendered) && l1keep > 0) {
                    l1keep = 0;
                    rendered = render();
                }
                inline += i >= l1keep
                    ? rendered
                    : indentText(rendered, indentForm, curLineWidth, false);
            }
            inline += ")";
            return hlWrapper(indentText(inline, indentForm, indent, false), false);
        }

        if (node && typeof node === "object") {
            const entries = Object.entries(node);
            if (entries.length === 0) return hlWrapper("{}", false);

            const parts = entries.map(([k, v], i) => {
                const keyPath: Path = [...path, k, true];
                const keyStr = this.#escapeString(k);
                const renderedKey = pathMatches(keyPath) ? this.highlight(keyStr, true) : keyStr;
                const valueCol = this.unFormat(renderedKey).length + 2;
                const val = recur(v, i, [...path, k], null, availableWidth - valueCol - 1);
                return `${renderedKey}: ${indentText(val, indentForm, valueCol, false)}`;
            });

            var str1 = "{", str2 = str1;
            for (var i = 0; i < parts.length; i++) {
                if (i > 0) {
                    str1 += ",\n";
                    str2 += ", ";
                }
                const s = parts[i]!;
                str1 += indentText(s, indentForm, 1, i > 0);
                str2 += s;
            }
            str1 += "}";
            str2 += "}";
            if (this.unFormat(str2).length > availableWidth || /\n/.test(str2)) return hlWrapper(str1, false);
            return hlWrapper(str2, false);
        }

        const flag = isString(currentFormat) ? null : currentFormat?.flag;
        return hlWrapper(this.handleAtom(node, pathMatches(path), flag!, parent, parentIndex, availableWidth), true);
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
import { isArray } from "lib0/array";
import { isString } from "lib0/function";
import { stringify } from "lib0/json";
import { max } from "lib0/math";
import { HasDocstring } from "./doc";
import { JebVM } from "./vm";

type Path = (string | number | boolean)[];
export type Format =
    | string
    | {
        line1keep?: number;
        indent?: number;
        childrenForce?: (Format | null)[];
        atomFlag?: string;
    };

export class Formatter {
    #vm: JebVM;

    constructor(
        vm: JebVM,
        public baseIndent = 2,
        public maxWidth = 100) {
        this.#vm = vm;
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
        return this.escape(/^[\p{L}_$][\p{L}\p{N}_$+*@%^&/-]*$/u.test(string) ? string : stringify(string).replace(/(?<!\\)\\n/g, "\n"));
    }
    handleAtom(atom: any, isSelected: boolean, flag: string | null, parent: any, parentIndex: number, availableWidth: number) {
        return isString(atom)
            ? this.#escapeString(atom)
            : String(atom);
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
        const wrap = (s: string, isAtom: boolean) => pathMatches(path) ? this.highlight(s, isAtom) : s;
        const recur = (n: any, i: number, p: Path, childFmt?: Format | null, width: number = availableWidth) =>
            this.#superprint(n, node, i, sel, width, p, childFmt);

        if (isArray(node)) {
            if (node.length === 0) return wrap("()", true);

            const fmt = currentFormat ?? this.#getFormat(node);

            // sigil like $x 'x `x ,x ,@x 
            if (isString(fmt)) {
                return indentText(
                    wrap(
                        (pathMatches([...path, 0]) ? this.highlight(fmt, true) : fmt)
                        + recur(node[1]!, 1, [...path, 1], null, availableWidth - fmt.length), false),
                    indentForm,
                    fmt.length,
                    false);
            }

            var { line1keep, indent, childrenForce = [] } = fmt ?? {};
            indent ||= this.baseIndent;

            const rendered = node.map((c, i) => {
                const width = i >= line1keep! ? availableWidth - indent! : availableWidth;
                return recur(c, i, [...path, i], childrenForce[i], width);
            });

            if (!line1keep) {
                const inline = `(${rendered.join(" ")})`;
                if ((!isString(node[0]) && typeof node[0] !== "object") || (inline.length <= availableWidth)) return wrap(inline, false);
            }

            line1keep ||= 1;
            var str = "(";
            for (var i = 0; i < node.length; i++) {
                if (i >= line1keep) str += "\n";
                else if (i > 0) str += " ";
                str += i >= line1keep
                    ? rendered[i]!
                    : indentText(rendered[i]!, indentForm,
                        max(0, str.length - str.lastIndexOf("\n") - indent - 1),
                        false);
            }
            str += ")";
            return wrap(indentText(str, indentForm, indent, false), false);
        }

        if (node && typeof node === "object") {
            const entries = Object.entries(node);
            if (entries.length === 0) return wrap("{}", false);

            const parts = entries.map(([k, v], i) => {
                const keyPath: Path = [...path, k, true];
                const keyStr = this.#escapeString(k);
                const renderedKey = pathMatches(keyPath) ? this.highlight(keyStr, true) : keyStr;
                const valueCol = renderedKey.length + 2;
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
            if (str2.length > availableWidth || /\n/.test(str2)) return wrap(str1, false);
            return wrap(str2, false);
        }

        const flag = isString(currentFormat) ? null : currentFormat?.atomFlag;
        return wrap(this.handleAtom(node, pathMatches(path), flag!, parent, parentIndex, availableWidth), true);
    }
    #getFormat(form: any[]): Format | null {
        const name = form[0];
        if (!name) return null;
        const { value, ok } = this.#vm.globalEnv.get(name);
        if (!ok) return null;
        if (!(value instanceof HasDocstring)) return null;
        const headerForms = value.doc.headerData;
        var breakage: Format | null = null;
        for (var headerForm of headerForms) {
            if (headerForm.matches(form)) {
                const b = headerForm.breakage;
                // Sigil form takes priority
                if (isString(b)) return b;
                else breakage ??= b;
            }
        }
        return breakage;
    }
};



function indentText(text: string, form: (width: number) => string, indent: number, indentFirst: boolean): string {
    return text.split("\n").map((line, i) => (indentFirst || i > 0 ? (form(indent) + line) : line).trimEnd()).join("\n");
}
import { isArray, last } from "lib0/array";
import { undefinedToNull } from "lib0/conditions";
import { id } from "lib0/function";
import { stringify } from "lib0/json";
import { ceil, max } from "lib0/math";

type JSONVal = null | boolean | number | string | JSONVal[] | { [k: string]: JSONVal };
type Path = (string | number | boolean)[];
export type Format =
    | string
    | {
        line1keep?: number;
        indent?: number;
        childrenForce?: (Format | null)[];
    };

export function superprint(
    node: JSONVal,
    highlight: (s: string) => string,
    sel: Path,
    escape: (s: string) => string = id,
    getFormat: (form: any[]) => Format | null = () => null,
    baseIndent = 2,
    maxWidth = 80,
    indentForm: (width: number) => string = x => " ".repeat(x),
    path: Path = [],
    currentFormat: Format | null = null
): string {
    const eq = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);
    const wrap = (s: string) => eq(path, sel) ? highlight(s) : s;
    const recur = (n: JSONVal, p: Path, childFmt?: Format | null, width: number = maxWidth) =>
        superprint(n, highlight, sel, escape, getFormat, baseIndent, width, indentForm, p, childFmt);

    if (isArray(node)) {
        if (node.length === 0) return wrap("()");

        const fmt = currentFormat ?? getFormat(node);

        // sigil like $x 'x `x ,x ,@x 
        if (typeof fmt === "string") {
            return indentText(
                wrap(
                    (eq([...path, 0], sel) ? highlight(fmt) : fmt)
                    + recur(node[1]!, [...path, 1], null, maxWidth - fmt.length)),
                indentForm,
                fmt.length,
                false);
        }

        var { line1keep, indent, childrenForce = [] } = fmt ?? {};
        indent ||= baseIndent;

        const rendered = node.map((c, i) => {
            const width = i >= line1keep! ? maxWidth - indent! : maxWidth;
            return recur(c, [...path, i], childrenForce[i], width);
        });

        if (!line1keep) {
            const inline = `(${rendered.join(" ")})`;
            if (inline.length <= maxWidth) return wrap(inline);
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
        return wrap(indentText(str, indentForm, indent, false));
    }

    if (node && typeof node === "object") {
        const entries = Object.entries(node);
        if (entries.length === 0) return wrap("{}");

        const parts = entries.map(([k, v]) => {
            const keyPath: Path = [...path, k, true];
            const keyStr = escape(/^[\p{L}\p{N}_*+$-]*$/u.test(k) ? k : stringify(k));
            const renderedKey = eq(keyPath, sel) ? highlight(keyStr) : keyStr;
            const valueCol = renderedKey.length + 2;
            const val = recur(v, [...path, k], null, maxWidth - valueCol - 1);
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
        if (str2.length > maxWidth || /\n/.test(str2)) return wrap(str1);
        return wrap(str2);
    }

    const s = typeof node === "string"
        ? escape(/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(node) ? node : stringify(node).replace(/\\n/g, "\n"))
        : String(node);

    return wrap(s);
}

function indentText(text: string, form: (width: number) => string, indent: number, indentFirst: boolean): string {
    return text.split("\n").map((line, i) => (indentFirst || i > 0 ? (form(indent) + line) : line).trimEnd()).join("\n");
}
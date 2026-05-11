import { isArray, last } from "lib0/array";
import { isNumber, isString } from "lib0/function";
import { max } from "lib0/math";
import { BuiltinFunction, Lambda } from "./callable";
import { DocNode, DocNodeType, parseDoc } from "./doc";
import { Formatter } from "./format";
import { JebVM } from "./vm";

interface ThemeValue {
    style: string;
    param?: string;
}

interface KnownAtomThemeValue extends ThemeValue {
    text: string;
}

export interface Theme {
    highlight: ThemeValue,
    noHighlight: ThemeValue,
    nil: KnownAtomThemeValue,
    number: ThemeValue,
    string: ThemeValue,
    true: KnownAtomThemeValue,
    false: KnownAtomThemeValue,
    quoted: ThemeValue,
    defmacro: ThemeValue,
    defun: ThemeValue,
    defvar: ThemeValue,
    border: ThemeValue,
    italic: ThemeValue,
    bold: ThemeValue,
    param: ThemeValue,
    reference: ThemeValue,
    code: ThemeValue,

}

export class KAPLAYFormatter extends Formatter {
    constructor(vm: JebVM, public theme: Theme) {
        super(vm);
    }
    escape(text: string) {
        return [...text].map(e => /[\[\]\\]/.test(e) ? "\\" + e : e).join("");
    }
    highlight(s: string) {
        return this.#style(s.split("\n").map((l, i) => (i === 0 ? "" : this.#style("\n", this.theme.noHighlight)) + l).join(""), this.theme.highlight);
    }
    unFormat(string: string) {
        return compileStyledText(string).text;
    }
    handleAtom(atom: any, selected: boolean, flag: string | null, parent: any, parentIndex: number, availableWidth: number) {
        if (atom === null) {
            return this.#style("nil", this.theme.nil);
        }
        if (isNumber(atom)) {
            return this.#style(atom.toString(), this.theme.number);
        }
        if (typeof atom === "boolean") {
            return this.#style(null, atom ? this.theme.true : this.theme.false);
        }
        if (isString(atom) && this.prettySyntax) {
            if (flag === "docstring") return this.#richTextDoc(atom, availableWidth);
            if (flag === "comment" && parentIndex > 0) return this.#richTextComment(atom, availableWidth);
        }
        const name = super.handleAtom(atom, selected, flag, parent, parentIndex, availableWidth);
        if (parentIndex === 0 && !flag) {
            const { value } = this.vm.globalEnv.get(atom);
            if (value instanceof Lambda) {
                flag = value.isMacro ? "defmacro" : "defun";
            }
            else if (value instanceof BuiltinFunction) {
                flag = value.isSpecial ? "defmacro" : "defun";
            }
            else if (atom === "return") {
                flag = "defmacro";
            } else if (!value) {
                flag = "defvar";
            }
        }
        return this.#style(name, this.theme[(flag === "defun" || flag === "defvar" || flag === "defmacro") ? flag : "string"]);
    }
    #style(x: string | null, style: ThemeValue | KnownAtomThemeValue) {
        return `[${style.style}${style.param ? "=" + style.param : ""}]${x ?? (style as KnownAtomThemeValue)?.text}[/${style.style}]`;
    }
    #wordWrap(string: DocNode, maxWidth: number) {
        const lines: [string, number][] = [];
        const newLine = () => {
            lines.push(["", 0]);
        };
        newLine();
        const pushWord = (text: string, width: number) => {
            var l = last(lines);
            if ((l[1] + width) > (maxWidth)) {
                newLine();
                l = last(lines);
                const s = l[0].trimEnd();
                l[1] -= l[0].length - s.length;
                l[0] = s;
                if (/^\s+$/.test(text)) return;
            }
            l[0] += text;
            l[1] += width;
        };
        const process = (node: DocNode) => {
            if (isArray(node)) {
                const n = node[0] ? this.theme[(<Record<DocNodeType, keyof Theme>>{
                    i: "italic",
                    b: "bold",
                    p: "param",
                    code: "code",
                    ref: "reference",
                })[node[0]]] : undefined;
                if (n) pushWord(`[${n.style}${n.param ? "=" + n.param : ""}]`, 0);
                for (var i = 1; i < node.length; i++) {
                    process(node[i]!);
                }
                if (n) pushWord(`[/${n.style}]`, 0);
            }
            else {
                for (var c of node.match(/\S+|\s+/g)!) {
                    pushWord(this.escape(c), c.length);
                }
            }
        };
        process(string);
        return lines;
    }
    #borders(bodyWidth: number) {
        const line = "━".repeat(bodyWidth);
        const top = "┏" + line + "┓";
        const bottom = "┗" + line + "┛";
        const middle = "┣" + line + "┫";
        return [top, middle, bottom].map(l => this.#style(l, this.theme.border));
    }
    #block2(a: [string, number][], b: [string, number][] = []) {
        const ml = (a: any, [_, w]: [string, number]) => max(a, w);
        const s = this.#style("┃", this.theme.border);
        const p = ([line, width]: [string, number]) => s + line + " ".repeat(realWidth - width) + s;
        const realWidth = max(a.reduce(ml, 0), b.reduce(ml, 0));
        const [top, middle, bottom] = this.#borders(realWidth);
        return [
            top,
            ...a.map(p),
            ...(b.length ? [middle] : []),
            ...b.map(p),
            bottom,
        ].join("\n");
    }
    #richTextDoc(doc: string, maxWidth: number) {
        const parsed = parseDoc(doc);
        const headerLines = parsed.headers.flatMap(line => this.#wordWrap(line, maxWidth - 2));
        const lines = parsed.body.flatMap(para => this.#wordWrap(["" as DocNodeType, ...para], maxWidth - 2).concat([["", 0]]))
        lines.pop();
        return this.#block2(headerLines, lines);
    }
    #richTextComment(str: string, maxWidth: number) {
        return this.#block2(this.#wordWrap(str, maxWidth - 2));
    }
}
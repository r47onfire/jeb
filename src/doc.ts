import { isArray, last } from "lib0/array";
import { isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { Format } from "./superprint";

type DocNode = string | [string, ...any[]];

export interface Doc {
    headerData: HeaderForm[];
    headers: DocNode[];
    body: DocNode[][];
}

export class HasDocstring {
    readonly doc: Doc;
    constructor(docstring: string) {
        const doc = this.doc = { headerData: [], headers: [], body: [] } as Doc;
        docstring = docstring.split("\n").map(s => s.trimEnd()).join("\n");
        if (!docstring) return;
        const [head, ...body] = docstring.split("\n\n");
        const paragraphs = body.flatMap(l => l.split("\n"));
        const headlines = head!.split("\n");
        var i = 0;
        headlines.forEach(h => {
            const [header, jsonHeader, rest] = parseHeader(h);
            if (rest) paragraphs.splice(i++, 0, rest);
            if (header) doc.headers.push(header);
            if (jsonHeader) doc.headerData.push(jsonHeader);
        });
        doc.body = paragraphs.map(parseInline);
    }
}

export function parseInline(s: string): DocNode[] {
    const root: DocNode = ["root"];
    const stack: DocNode[][] = [root];
    var i = 0;

    const pushText = (t: string) => {
        if (t) last(stack)!.push(t);
    };

    while (i < s.length) {
        // escaped character
        if (s.startsWith("\\", i)) {
            pushText(s[i + 1]!);
            i += 2;
            continue;
        }
        // [[ref]]
        if (s.startsWith("[[", i)) {
            const j = s.indexOf("]]", i);
            if (j !== -1) {
                last(stack)!.push(["ref", s.slice(i + 2, j)]);
                i = j + 2;
                continue;
            }
        }
        // **bold**
        if (s.startsWith("**", i)) {
            const top = last(stack)! as DocNode;
            if (isArray(top) && top[0] === "b") stack.pop();
            else { const n: DocNode = ["b"]; last(stack)!.push(n); stack.push(n); }
            i += 2;
            continue;
        }
        // *italic*
        if (s.startsWith("*", i)) {
            const top = last(stack)! as DocNode;
            if (isArray(top) && top[0] === "i") stack.pop();
            else { const n: DocNode = ["i"]; last(stack)!.push(n); stack.push(n); }
            i++;
            continue;
        }
        // `code`
        if (s.startsWith("`", i)) {
            const top = last(stack)! as DocNode;
            if (isArray(top) && top[0] === "code") stack.pop();
            else { const n: DocNode = ["code"]; last(stack)!.push(n); stack.push(n); }
            i++;
            continue;
        }
        // plain text to next delimiter
        const next = s.slice(i).search(/(\*\*|[*`]|\[\[|\\)/);
        const end = next === -1 ? s.length : i + next;
        pushText(s.slice(i, end));
        i = end;
    }
    return root.slice(1) as DocNode[];
}

class HeaderForm {
    #sigil: string | undefined;
    #spec: any[];
    #placeholders: Map<string, string>;
    #actions: Map<string, string>;
    constructor(
        data: any[],
        placeholders: Map<string, string>,
        placeholderToActionMap: Map<string, string>,
    ) {
        this.#spec = data;
        this.#placeholders = placeholders;
        this.#actions = placeholderToActionMap;
        if (data.length === 2 && /^[\p{P}\p{S}\p{Z}]+$/u.test(data[0])) this.#sigil = data[0];
    }
    matches(data: any): boolean {
        const recur = (form: any, spec: any): boolean => {
            if (!isArray(spec)) return this.#placeholders.has(spec) || form === spec;
            if (!isArray(form)) return false;
            if (form.length < spec.length) return false;
            const bodyThing = last(spec);
            if (!(this.#placeholders.get(bodyThing)?.endsWith("...")) && form.length > spec.length) return false;
            var i = 0;
            for (; i < form.length; i++) {
                if (!recur(form[i], spec[i] ?? bodyThing)) return false;
            }
            return true;
        };
        return recur(data, this.#spec);
    }
    breakage(data: any[]): Format | null {
        if (this.#sigil) return this.#sigil;
        const recur = (form: any[]) => {
            var line1keep, indent = 0, childrenForce: Format[] = [];
            const end = last(form);
            const p = this.#placeholders.get(end);
            if (p) {
                const action = this.#actions.get(p);
                if (p.endsWith("...")) {
                    line1keep = form.length - 1;
                }
                if (action === "sameline") {
                    line1keep = Infinity;
                }
                else if (action === "eachline") {
                    line1keep = indent = 1;
                }
            }
            for (var i = 0; i < form.length; i++) {
                if (isArray(form[i])) childrenForce[i] = recur(form[i]);
            }
            return { line1keep, indent, childrenForce }
        };
        const b = recur(this.#spec);
        console.log({ spec: this.#spec, breakage: b });
        return b;
    }
}

function parseHeader(header: string): [DocNode | undefined, HeaderForm | undefined, string | undefined] {
    const wildcardMap = new Map<string, string>();
    const actionMap = new Map<string, string>();
    var header2 = header.replaceAll(/<([^<>]+?)(:[^<>]+)?>/g, (_, wildcard, action) => {
        const gensym = `__${wildcard}_${Math.random().toString(36).slice(2, 18)}`;
        wildcardMap.set(gensym, wildcard);
        if (action) actionMap.set(wildcard, action.slice(1));
        return stringify(gensym);
    });
    try { header2 = parse(header2); } catch { return [, , header]; }
    const walk = (item: any): any => {
        if (isArray(item)) {
            return ["code", "[", ...item.flatMap((x, i) => i > 0 ? [", ", walk(x)] : [walk(x)]), "]"];
        } else if (wildcardMap.has(item)) {
            return ["i", wildcardMap.get(item)];
        } else if (isString(item)) {
            return stringify(item);
        } else {
            return String(item);
        }
    }
    return [walk(header2), new HeaderForm(header2 as any, wildcardMap, actionMap), ,];
}

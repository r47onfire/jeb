import { isArray, last } from "lib0/array";
import { isString } from "lib0/function";
import { parse, stringify } from "lib0/json";
import { Format } from "./format";

export type DocNodeType = "i" | "b" | "p" | "code" | "ref";

export type DocNode = string | [DocNodeType, ...(string | DocNode)[]];

export interface Doc {
    headerData: HeaderForm[];
    headers: DocNode[];
    body: DocNode[][];
}

export class HasDocstring {
    readonly doc: Doc;
    constructor(docstring: string) {
        this.doc = parseDoc(docstring);
    }
}

export function parseDoc(docstring: string): Doc {
    const doc: Doc = { headerData: [], headers: [], body: [] };
    docstring = docstring.split("\n").map(s => s.trimEnd()).join("\n");
    if (!docstring) return doc;
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
    return doc;
}

function parseInline(s: string): DocNode[] {
    const root: DocNode = ["" as DocNodeType];
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
    constructor(
        public readonly spec: any[],
        public readonly placeholders: Map<string, string>,
        public readonly actions: Map<string, string>,
        public readonly flags: Map<string, string>,
    ) { }
    matches(data: any): boolean {
        const recur = (form: any, spec: any): boolean => {
            if (!isArray(spec)) return this.placeholders.has(spec) || form === spec;
            if (!isArray(form)) return false;
            if (form.length < spec.length) return false;
            const bodyThing = last(spec);
            if (!(this.placeholders.get(bodyThing)?.endsWith("...")) && form.length > spec.length) return false;
            var i = 0;
            for (; i < form.length; i++) {
                if (!recur(form[i], spec[i] ?? bodyThing)) return false;
            }
            return true;
        };
        return recur(data, this.spec);
    }
}

export function getBreakage(header: HeaderForm, form: any): Format | null {
    const { spec, placeholders, actions, flags } = header;
    var sig;
    if (spec.length === 2 && /^[\p{P}\p{S}\p{C}\p{Z}]+$/u.test(spec[0])) sig = spec[0];
    // Calculate breakage
    const recur = (spec: any[], form: any[]): Format => {
        var l1keep, indent = 0, children: Format[] = [];
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
            const p = placeholders.get(f);
            if (!p) continue;
            const action = actions.get(p);
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
                const p2 = placeholders.get(p);
                if (!p2) continue;
                const flag = flags.get(p2);
                if (flag) {
                    // Kludge... hmmm.
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
        return { l1keep, indent, children }
    };
    const res = recur(spec, form);
    if (sig) {
        console.log(sig);
        res.sig = sig;
    }
    return res;
}

function parseHeader(header: string): [DocNode | undefined, HeaderForm | undefined, string | undefined] {
    const wildcardMap = new Map<string, string>();
    const actionMap = new Map<string, string>();
    const flagMap = new Map<string, string>();
    var header2 = header.replaceAll(/<([^<>]+?)(:[^<>]+?)?(\+[^<>]+?)?>/g, (_, wildcard, action, flag) => {
        const gensym = `__${wildcard}_${Math.random().toString(36).slice(2, 18)}`;
        wildcardMap.set(gensym, wildcard);
        if (action) actionMap.set(wildcard, action.slice(1));
        if (flag) flagMap.set(wildcard, flag.slice(1));
        return stringify(gensym);
    });
    try { header2 = parse(header2); } catch { return [, , header]; }
    const walk = (item: any): DocNode => {
        if (isArray(item)) {
            return ["code", "[", ...item.flatMap((x, i) => i > 0 ? [", ", walk(x)] : [walk(x)]), "]"];
        } else if (wildcardMap.has(item)) {
            return ["p", wildcardMap.get(item)!];
        } else if (isString(item)) {
            return stringify(item);
        } else {
            return String(item);
        }
    }
    return [walk(header2), new HeaderForm(header2 as any, wildcardMap, actionMap, flagMap), ,];
}

import { isArray, last } from "lib0/array";
import { isString } from "lib0/function";
import { parse, stringify } from "lib0/json";

export type DocNodeType = "i" | "b" | "p" | "code" | "ref";

export type DocNode = string | [DocNodeType, ...DocNode[]];

export interface Doc {
    headerData: HeaderForm[];
    headers: DocNode[];
    body: DocNode[][];
}

export interface HasDocstring {
    readonly doc: string;
}

export const parseDoc = (docstring: string): Doc => {
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

const parseInline = (s: string): DocNode[] => {
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

export class HeaderForm {
    constructor(
        public readonly spec: any[],
        public readonly placeholders: Map<string, string>,
        public readonly actions: Map<string, string>,
    ) { }
    matches(data: any): boolean {
        const recur = (form: any, spec: any, shouldCareAboutFirst: boolean): boolean => {
            if (!isArray(spec)) return this.placeholders.has(spec) || form === spec;
            if (!isArray(form)) return false;
            if (form.length < spec.length) return false;
            const bodyThing = last(spec);
            if (form.length > spec.length && !(this.placeholders.get(bodyThing)?.endsWith("..."))) return false;
            var i = 0;
            for (; i < form.length; i++) {
                if (i < 1 && !shouldCareAboutFirst) continue;
                if (!recur(form[i], spec[i] ?? bodyThing, true)) return false;
            }
            return true;
        };
        return recur(data, this.spec, false);
    }
}

const parseHeader = (header: string): [node: DocNode | undefined, form: HeaderForm | undefined, rest: string | undefined] => {
    const wildcardMap = new Map<string, string>();
    const actionMap = new Map<string, string>();
    var header2 = header.replaceAll(/<([^<>]+?)(:[^<>]+?)?>/g, (_, wildcard, action) => {
        const gensym = `__${wildcard}_${Math.random().toString(36).slice(2, 18)}`;
        wildcardMap.set(gensym, wildcard);
        if (action) actionMap.set(wildcard, action.slice(1));
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
    return [walk(header2), new HeaderForm(header2 as any, wildcardMap, actionMap), ,];
}

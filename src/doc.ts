import { isArray, last } from "lib0/array";
import { isString } from "lib0/function";
import { parse, stringify } from "lib0/json";

type DocNode = string | [string, ...any[]];

export interface Doc {
    headers: DocNode[];
    body: DocNode[][];
}

export class HasDocstring {
    readonly doc: Doc;
    constructor(docstring: string) {
        const doc: Doc = this.doc = { headers: [], body: [] };
        if (!docstring) return;
        const [head, ...body] = docstring.split("\n\n");
        const paragraphs = body.flatMap(l => l.split("\n"));
        const headlines = head!.split("\n");
        var i = 0;
        headlines.forEach(h => {
            const [header, rest] = parseHeader(h);
            if (rest) paragraphs.splice(i++, 0, rest);
            if (header) doc.headers.push(header);
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

function parseHeader(header: string): [DocNode | undefined, string | undefined] {
    const wildcardMap = new Map<string, string>();
    var header2 = header.replaceAll(/<([^<>]+?)>/g, (_, wildcard) => {
        const gensym = `__$__$${Math.random()}_${wildcard}`;
        wildcardMap.set(gensym, wildcard);
        return stringify(gensym);
    });
    try { header2 = parse(header2); } catch { return [, header]; }
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
    return [walk(header2), ,];
}

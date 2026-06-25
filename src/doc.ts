import { isArray, last } from "lib0/array";
import { isString } from "lib0/function";
import { parse, stringify } from "lib0/json";

/**
 * Formatting tag for a documentation entry.
 * * i = italics
 * * b = bold
 * * p = paragraph
 * * c = inline code
 * * u = unordered list (bullets)
 * * o = ordered list (numbers)
 * * l = list item
 * * param = parameter placeholder
 * * ref = reference to another function/macro
 */
export type DocNodeType =
    | "i"
    | "b"
    | "p"
    | "c"
    | "u"
    | "o"
    | "l"
    | "param"
    | "ref";

/**
 * Documentation tree document
 */
export type DocNode = string | [DocNodeType, ...DocNode[]];

/**
 * Parsed documentation data for something (e.g. builtin function, lambda)
 */
export interface Doc {
    /** Parsed header documentation, in a structured format, for e.g. autoformatting */
    headerData: HeaderForm[];
    /** Rendered header data */
    headers: DocNode[];
    /** Rendered body documentation data. each outer list is a single paragraph */
    body: DocNode[];
}

/**
 * interface for a thing that has a docstring.
 */
export interface HasDocstring {
    readonly doc: string;
}

/**
 * Parse the documentation string into {@link Doc} data
 * @returns the doc data, or empty doc data if it didn't parse right
 */
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
    doc.body = parseParagraphs(paragraphs);
    return doc;
}

const enum ParagraphState {
    PARAGRAPH,
    NUMBERED_LIST,
    BULLETED_LIST
}

const parseParagraphs = (lines: string[]): DocNode[] => {
    var state: ParagraphState = ParagraphState.PARAGRAPH;
    const items: DocNode[] = [];
    var currentList: DocNode | undefined, match: RegExpExecArray | null;
    for (var line of lines) {
        if (line.startsWith("* ")) {
            if (state !== ParagraphState.BULLETED_LIST) {
                currentList = ["u"];
                items.push(currentList!);
            }
            (currentList as DocNode[])!.push(["l", ...parseInline(line.slice(2))]);
            state = ParagraphState.BULLETED_LIST;
        } else if ((match = /^\d*\.\s/.exec(line)) !== null) {
            if (state !== ParagraphState.NUMBERED_LIST) {
                currentList = ["o"];
                items.push(currentList!);
            }
            (currentList as DocNode[])!.push(["l", ...parseInline(line.slice(match[0].length))]);
            state = ParagraphState.NUMBERED_LIST;
        } else {
            items.push(["p", ...parseInline(line)]);
            state = ParagraphState.PARAGRAPH;
        }
    }
    return items;
}

const parseInline = (s: string): DocNode[] => {
    const root: DocNode = ["" as DocNodeType];
    const stack: DocNode[][] = [root];
    var i = 0;

    const pushText = (t: string) => {
        if (t) last(stack)!.push(t);
    };

    const startNode = (t: DocNodeType) => {
        const n: DocNode = [t];
        last(stack)!.push(n);
        stack.push(n);
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
            else startNode("b");
            i += 2;
            continue;
        }
        // *italic*
        if (s.startsWith("*", i)) {
            const top = last(stack)! as DocNode;
            if (isArray(top) && top[0] === "i") stack.pop();
            else startNode("i");
            i++;
            continue;
        }
        // `code`
        if (s.startsWith("`", i)) {
            const top = last(stack)! as DocNode;
            if (isArray(top) && top[0] === "c") stack.pop();
            else startNode("c");
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
            return ["c", "[", ...item.flatMap((x, i) => i > 0 ? [", ", walk(x)] : [walk(x)]), "]"];
        } else if (wildcardMap.has(item)) {
            return ["param", wildcardMap.get(item)!];
        } else if (isString(item)) {
            return stringify(item);
        } else {
            return String(item);
        }
    }
    return [walk(header2), new HeaderForm(header2 as any, wildcardMap, actionMap), ,];
}

/**
 * Structural form of a particular way to call a function or macro
 */
export class HeaderForm {
    constructor(
        public readonly spec: any[],
        public readonly placeholders: Map<string, string>,
        public readonly actions: Map<string, string>,
    ) { }
    /**
     * Checks if this form matches the way it's being called
     * @param data Call code to check - first item (the function itself) is ignored
     */
    matches(data: any): boolean {
        const recur = (form: any, spec: any, shouldCareAboutFirst: boolean): boolean => {
            if (!isArray(spec)) return this.placeholders.has(spec) || form === spec;
            if (!isArray(form)) return false;
            if (form.length < spec.length) return false;
            const bodyThing = last(spec);
            if (form.length > spec.length && !(this.placeholders.get(bodyThing)?.endsWith("..."))) return false;
            for (var i = 0; i < form.length; i++) {
                if (i < 1 && !shouldCareAboutFirst) continue;
                if (!recur(form[i], spec[i] ?? bodyThing, true)) return false;
            }
            return true;
        };
        return recur(data, this.spec, false);
    }
}

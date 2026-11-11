import { Identifier } from "./utils";

/**
 * Where an IR node came from, generic over the embedding compiler's span type
 * `S` (e.g. Nebula's `Span`), so the runtime never has to import the compiler's
 * types.
 *
 * `expandedFrom` marks macro expansion provenance: when code is produced by
 * expanding a macro (or any other code-generating step), the generated node's
 * source keeps its own `span` -- where the code sits in the macro's definition
 * -- and gains an `expandedFrom` link to the source of the invocation that
 * produced it. The invocation's own `expandedFrom` link, if any, continues the
 * chain outward, so the full expansion history of a node can be walked from the
 * innermost expansion to the outermost.
 */
export interface SourceInfo<S = unknown> {
    /** The node's own source span, in the compiler's span type. */
    span?: S;
    /** Source of the macro invocation that generated this node, if any. */
    expandedFrom?: SourceInfo<S>;
}

/**
 * One IR node: a Lisp-form array whose first element is the opcode name, whose
 * second element is the node's {@link SourceInfo} (or a bare span, or
 * `undefined` when no source is known), and whose remaining elements are the
 * opcode's operands.
 *
 * Every array in code position is an IR node; literal arrays are data and only
 * ever appear as operands (e.g. of `const`), never in code position. Nodes are
 * walked pre-order: the opcode handler receives its operands unevaluated and
 * decides which of them to evaluate, skip, or evaluate repeatedly.
 */
export type IRNode<S = unknown> = [
    op: string,
    source: SourceInfo<S> | S | undefined,
    ...operands: any[],
];

/** Whether the value is shaped like an {@link IRNode}. */
export const isIRNode = (x: unknown): x is IRNode<any> =>
    Array.isArray(x) && typeof x[0] === "string";

/**
 * Normalizes the source slot of an {@link IRNode} (or a standalone source) to a
 * {@link SourceInfo}: a bare span is wrapped, a `SourceInfo` is passed through,
 * and `undefined`/`null` stays `undefined`.
 */
export const normalizeSource = <S>(
    source: SourceInfo<S> | S | undefined | null,
): SourceInfo<S> | undefined => {
    if (source === undefined || source === null) return undefined;
    if (
        typeof source === "object" &&
        ("span" in source || "expandedFrom" in source)
    )
        return source as SourceInfo<S>;
    return { span: source as S };
};

/** The normalized {@link SourceInfo} of an {@link IRNode}, if it has one. */
export const nodeSource = <S>(node: IRNode<S>): SourceInfo<S> | undefined =>
    normalizeSource(node[1]);

/**
 * Builds an {@link IRNode}. `source` may be a {@link SourceInfo}, a bare span in
 * the compiler's span type, or `undefined`.
 */
export const op = <S = unknown>(
    name: string,
    source: SourceInfo<S> | S | undefined,
    ...operands: any[]
): IRNode<S> => [name, source, ...operands] as IRNode<S>;

/**
 * A stable string key for a source, used to compare sources for equality (e.g.
 * when compressing tracebacks). Spans are compared by their JSON representation
 * when they have one, and by `String()` otherwise.
 */
export const sourceKey = (
    source: SourceInfo<any> | undefined,
    depth = 0,
): string => {
    if (!source || depth > 16) return "";
    let spanKey: string;
    try {
        spanKey = JSON.stringify(source.span) ?? String(source.span);
    } catch {
        spanKey = String(source.span);
    }
    return spanKey + "<-" + sourceKey(source.expandedFrom, depth + 1);
};

/** Whether two sources denote the same place, expansion history included. */
export const sourcesEqual = (
    a: SourceInfo<any> | undefined,
    b: SourceInfo<any> | undefined,
): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    return sourceKey(a) === sourceKey(b);
};

const appendChain = <S>(
    link: SourceInfo<S>,
    tail: SourceInfo<S>,
): SourceInfo<S> =>
    link.expandedFrom === undefined
        ? { ...link, expandedFrom: tail }
        : { ...link, expandedFrom: appendChain(link.expandedFrom, tail) };

/**
 * Marks an IR node as the result of expanding the macro invocation at
 * `invocation` (the invocation node's own source). Returns a copy of the node
 * with its source's `expandedFrom` extended by the invocation source; the
 * node's own span is left alone. Only the root of the expansion is stamped --
 * nested nodes keep the sources they were built with, and the evaluator pushes
 * the root's expansion link as context while the subtree runs (see
 * `expansionStack` on the VM).
 */
export const markExpansion = <S>(
    node: IRNode<S>,
    invocation: SourceInfo<S> | undefined,
): IRNode<S> => {
    if (invocation === undefined) return node;
    const old = nodeSource(node);
    const stamped = [...node] as IRNode<S>;
    stamped[1] = {
        span: old?.span,
        expandedFrom: old?.expandedFrom
            ? appendChain(old.expandedFrom, invocation)
            : invocation,
    };
    return stamped;
};

/** A name usable as an operand: a variable name or a parameter name. */
export type NameOperand = Identifier;

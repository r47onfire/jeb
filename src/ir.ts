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

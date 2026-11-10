import { javaHash, rotate32 } from "@r47onfire/game-math";
import { SourceInfo, sourceKey, sourcesEqual } from "./ir";
import { Identifier } from "./utils";
import { JebVM, pushCommand, pushData, StackEntryKind } from "./vm";
import { Continuation } from "./continuation";

/** Extra options accepted when constructing a {@link JEBError}. */
export interface JEBErrorOptions<D = any, S = any> {
    /**
     * Sub-errors bundled into this error, e.g. several failures reported
     * together.
     */
    children?: JEBError<D, S>[];
}

/**
 * Arbitrary extra data attached to a {@link JEBError}. The `return` key is
 * special: it holds the restart continuation that a host error handler can
 * invoke to resume execution at the expression that caused the error.
 */
export interface JEBErrorContext<D = any, S = any> {
    [x: string]: unknown;
    return?: Continuation<D, S>;
}

/**
 * Generic base class for an error thrown by a JEB program.
 *
 * JEB deliberately has no error taxonomy of its own: no numeric codes, no
 * inheritance graph. Classifying errors (and giving them codes) is the
 * embedding language's job (e.g. Kuiper's), which can subclass this or wrap it;
 * the core only ever raises plain `JEBError`s with a message.
 */
export class JEBError<D = any, S = any> extends Error {
    readonly children: JEBError<D, S>[];
    constructor(
        message?: string,
        readonly options: ErrorOptions & JEBErrorOptions<D, S> = {},
        readonly context: JEBErrorContext<D, S> = {},
        public traceback?: StackTreeNode[],
    ) {
        super(message ?? "unspecified error", { cause: options.cause });
        this.name = this.constructor.name;
        this.children = options.children ?? [];
    }
    toString(): string {
        return `${this.name}: ${this.message}${this.traceback
                ? `\ntraceback: ${formatStackTraceCompact(
                    compressStackTree(this.traceback),
                )}`
                : ""
            }${this.cause instanceof JEBError
                ? `\ncaused by: ${this.cause.toString()}`
                : ""
            }${this.children
                .map((c) =>
                    c
                        .toString()
                        .split("\n")
                        .map((l) => "  " + l)
                        .join("\n"),
                )
                .join("\n\n")}`;
    }
}

const STACKFRAME_JOINER = "<-";

/** Tree node representing a compressed stack trace */
export type StackTreeNode = Readonly<
    | {
        leaf: false;
        count: number;
        children: StackTreeNode[];
        hash: number;
    }
    | {
        leaf: true;
        name: Identifier | undefined;
        source: SourceInfo<any> | undefined;
        kind: StackEntryKind;
        hash: number;
    }
>;

/**
 * Creates a leaf stack tree node for a single call frame. The node's hash is
 * precomputed from the frame name and source so that equal frames can be
 * recognized (and folded together) by {@link compressStackTree}.
 */
export const createStackLeafNode = (
    name: Identifier | undefined,
    source: SourceInfo<any> | undefined,
    kind: StackEntryKind,
): StackTreeNode => {
    return {
        leaf: true,
        name,
        source,
        kind,
        hash:
            javaHash(String(name)) ^
            (source ? rotate32(javaHash(sourceKey(source)), 11) : 0xdeadbeef) ^
            rotate32(kind, 21),
    };
};

/**
 * Creates an inner stack tree node representing `count` repetitions of the
 * given child frames, with its hash precomputed from the children's hashes.
 */
export const createStackInnerNode = (
    count: number,
    children: StackTreeNode[],
): StackTreeNode => {
    return {
        leaf: false,
        count,
        children,
        hash: children.reduce(
            (prev, { hash }) => rotate32(prev, 17) ^ hash,
            0x24354657,
        ),
    };
};

/**
 * Compresses a list of stack frames by folding each run of consecutively
 * repeating frame patterns into a single inner node (see {@link StackTreeNode}),
 * recursively, so that tracebacks of deeply recursive programs stay readable.
 */
export const compressStackTree = (nodes: StackTreeNode[]): StackTreeNode[] => {
    const len = nodes.length;
    if (len === 0) return [];

    const result: StackTreeNode[] = [];

    for (var i = 0; i < len;) {
        // Find the best repeating pattern starting at position i
        var bestLen = 1,
            bestCount = 1;

        // Try pattern lengths from 1 to half the remaining array
        const maxPatternLen = ((len - i) / 2) | 0;
        for (var patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
            var repeatCount = 1;

            // Count how many consecutive times this pattern repeats
            while (
                i + patternLen * (repeatCount + 1) <= len &&
                patternsEqual(
                    nodes,
                    i,
                    i + patternLen * repeatCount,
                    patternLen,
                )
            )
                repeatCount++;

            // Keep the match that repeats most times (tiebreak by longer pattern)
            if (
                repeatCount > 1 &&
                (repeatCount > bestCount ||
                    (repeatCount === bestCount && patternLen > bestLen))
            ) {
                bestLen = patternLen;
                bestCount = repeatCount;
            }
        }

        if (bestCount > 1) {
            // Create a compressed node containing the repeating pattern
            result.push(
                createStackInnerNode(
                    bestCount,
                    compressStackTree(nodes.slice(i, i + bestLen)),
                ),
            );
            i += bestLen * bestCount;
        } else {
            // No repeating pattern; recursively compress children if non-leaf
            const node = nodes[i]!;
            result.push(
                node.leaf
                    ? node
                    : createStackInnerNode(
                        node.count,
                        compressStackTree(node.children),
                    ),
            );
            i++;
        }
    }
    return result;
};

const patternsEqual = (
    nodes: StackTreeNode[],
    offset1: number,
    offset2: number,
    length: number,
): boolean => {
    for (var i = 0; i < length; i++) {
        if (!nodesEqual(nodes[offset1 + i]!, nodes[offset2 + i]!)) {
            return false;
        }
    }
    return true;
};

const nodesEqual = (node1: StackTreeNode, node2: StackTreeNode) => {
    // quick compare
    if (node1.hash !== node2.hash) return false;

    // either they're equal, or hash collision
    if (node1.leaf && node2.leaf) {
        if (node1.name !== node2.name) return false;
        if (node1.kind !== node2.kind) return false;
        return sourcesEqual(node1.source, node2.source);
    }
    if (!node1.leaf && !node2.leaf) {
        // For non-leaf nodes, count and structure must match
        return (
            node1.count === node2.count &&
            childrenEqual(node1.children, node2.children)
        );
    }
    return false;
};

const childrenEqual = (
    children1: StackTreeNode[],
    children2: StackTreeNode[],
): boolean => {
    return (
        children1.length === children2.length &&
        children1.every((child1, i) => nodesEqual(child1, children2[i]!))
    );
};

/**
 * Formats a stack tree as a compact string representation
 *
 * @param nodes The compressed stack tree nodes
 * @returns A formatted string like "foo <- bar <- (baz * 3) <- qux"
 */
export const formatStackTraceCompact = (nodes: StackTreeNode[]): string => {
    return nodes
        .map((item): string => {
            if (item.leaf) {
                switch (item.kind) {
                    case StackEntryKind.FUNCTION:
                        return String(item.name) || "<function ???>";
                    case StackEntryKind.MACRO_EXPANSION_RESULT:
                        return `<macro ${String(item.name || "???")}>`;
                    case StackEntryKind.PARAMETER:
                        return "parameter " + String(item.name);
                    case StackEntryKind.NONE:
                        return String(item.name);
                }
            }
            return `(${formatStackTraceCompact(item.children)} * ${item.count})`;
        })
        .join(STACKFRAME_JOINER);
};

/**
 * Runs the function, and if it throws an error that isn't a {@link JEBError},
 * wraps it in the given error type and re-throws it, otherwise returns the
 * function result.
 *
 * @example
 *     wrapThrowToError(() => doSomethingThatMayThrow());
 *
 * @param f The function to catch errors from
 */
export const wrapThrowToError = <T>(f: () => T) => {
    try {
        return f();
    } catch (e) {
        if (e instanceof JEBError) throw e;
        throw new JEBError(String(e), { cause: e });
    }
};

/**
 * Pauses the VM while the promise is pending, and then resumes it when it
 * resolves or rejects. A resolved value is pushed as the paused expression's
 * result as-is (including `NO_VALUE`); a rejection is rethrown inside the VM.
 */
export const promisifyVM = <D, S>(vm: JebVM<D, S>, promise: Promise<any>): void => {
    vm.paused = true;
    const { promise: finish, resolve } = Promise.withResolvers<void>();
    vm.awaiting = finish;
    promise.then(
        (result) => ((vm.paused = false), pushData(vm, result), resolve()),
        (error) => (
            (vm.paused = false),
            pushCommand(vm, () => {
                throw error;
            }),
            resolve()
        ),
    );
};

import { javaHash, rotate32 } from "@r47onfire/game-math";
import { Err, Ok, Result } from "ts-res";
import { NOTHING } from "./builtins/utils";
import { JebVM } from "./vm";

const STACKFRAME_JOINER = "<-";

/**
 * Tree node representing a compressed stack trace
 */
export type StackTreeNode = Readonly<{
    leaf: false,
    count: number;
    children: StackTreeNode[];
    hash: number;
} | {
    leaf: true,
    name: string;
    hash: number;
}>;

export const createStackLeafNode = (name: string): StackTreeNode => {
    return { leaf: true, name, hash: javaHash(name) };
};

export const createStackInnerNode = (count: number, children: StackTreeNode[]): StackTreeNode => {
    return { leaf: false, count, children, hash: children.reduce((prev, { hash }) => rotate32(prev, 17) ^ hash, 0x24354657) };
};

export const compressStackTree = (nodes: StackTreeNode[]): StackTreeNode[] => {
    if (nodes.length === 0) return [];

    const result: StackTreeNode[] = [];

    for (var i = 0; i < nodes.length;) {
        // Find the best repeating pattern starting at position i
        var bestLen = 1, bestCount = 1;

        // Try pattern lengths from 1 to half the remaining array
        const maxPatternLen = ((nodes.length - i) / 2) | 0;
        for (var patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
            var repeatCount = 1;

            // Count how many consecutive times this pattern repeats
            while (
                i + patternLen * (repeatCount + 1) <= nodes.length &&
                patternsEqual(nodes, i, i + patternLen * repeatCount, patternLen)
            ) {
                repeatCount++;
            }

            // Keep the match that repeats most times (tiebreak by longer pattern)
            if (repeatCount > 1 && (repeatCount > bestCount || (repeatCount === bestCount && patternLen > bestLen))) {
                bestLen = patternLen;
                bestCount = repeatCount;
            }
        }

        if (bestCount > 1) {
            // Create a compressed node containing the repeating pattern
            result.push(createStackInnerNode(bestCount, compressStackTree(nodes.slice(i, i + bestLen))));
            i += bestLen * bestCount;
        } else {
            // No repeating pattern; recursively compress children if non-leaf
            const node = nodes[i]!;
            result.push(node.leaf ? node : createStackInnerNode(node.count, compressStackTree(node.children)));
            i++;
        }
    }
    return result;
}

const patternsEqual = (
    nodes: StackTreeNode[],
    offset1: number,
    offset2: number,
    length: number
): boolean => {
    for (var i = 0; i < length; i++) {
        if (!nodesEqual(nodes[offset1 + i]!, nodes[offset2 + i]!)) {
            return false;
        }
    }
    return true;
}

const nodesEqual = (node1: StackTreeNode, node2: StackTreeNode) => {
    // quick compare
    if (node1.hash !== node2.hash) return false;

    // either they're equal, or hash collision
    if (node1.leaf && node2.leaf) {
        return node1.name === node2.name;
    }
    if (!node1.leaf && !node2.leaf) {
        // For non-leaf nodes, count and structure must match
        return node1.count === node2.count && childrenEqual(node1.children, node2.children);
    }
    return false;
}

const childrenEqual = (children1: StackTreeNode[], children2: StackTreeNode[]): boolean => {
    return children1.length === children2.length
        && children1.every((child1, i) => nodesEqual(child1, children2[i]!));
}


/**
 * Formats a stack tree as a compact string representation
 * @param node The compressed stack tree node
 * @returns A formatted string like "foo <- bar <- (baz * 3) <- qux"
 */
export const formatStackTraceCompact = (nodes: StackTreeNode[]): string => {
    return nodes.map(item => item.leaf ? item.name : `(${formatStackTraceCompact(item.children)} * ${item.count})`).join(STACKFRAME_JOINER);
};

/**
 * Formats the stack nicely and then throws the error
 * @param type type string for the error
 * @param message message of the error
 * @param stackTree The compressed stack tree from the VM
 */
export const jsError = (type: string, message: string, stackTree: StackTreeNode[]): never => {
    throw new Error(`(${type}) ${message}\nVM stack: ${formatStackTraceCompact(compressStackTree(stackTree))}`);
}
/**
 * Runs the function, and if it throws an error, pushes that error to be caught by JEB
 * code and returns {@link NOTHING}, otherwise returns the function result.
 * @param vm VM we're running in
 * @param kind Kind of JEB error a thrown error causes
 * @param f The function to catch errors from
 * @returns The result of the function or {@link NOTHING} if the function threw
 * @example
 * ```
 * defineBuiltin(vm, "test", null, false, false,
 *     (vm, args) => wrapThrowToError(vm, "test:testError",
 *         () => doSomethingThatMayThrow(vm, args[0])));
 * ```
 */
export const wrapThrowToError = <T>(vm: JebVM, kind: string, f: () => T) => {
    try {
        return f();
    } catch (e) {
        vm.pushCommand("jeb:throw", kind, String(e), {
            return: vm.cc(),
        });
        return NOTHING;
    }
}
/**
 * Runs the function, and if it returns a {@link Err} result, queues the error to be
 * caught by JEB code and returns {@link NOTHING}, otherwise if it's an {@link Ok}
 * just returns the result.
 * @param vm VM we're running in
 * @param kind Kind of JEB error an {@link Err} causes
 * @param result The result to look at
 * @returns The result of the function or {@link NOTHING} if the function threw
 * @example
 * ```
 * defineBuiltin(vm, "test", null, false, false,
 *     (vm, args) => resultToError(vm, "test:testError",
 *         doSomethingThatReturnsAResult(vm, args[0])));
 * ```
 */
export const resultToError = <T>(vm: JebVM, kind: string, result: Result<T, any>) => {
    if (result.ok) {
        return result.data;
    }
    vm.pushCommand("jeb:throw", kind, result.error, {
        return: vm.cc(),
    });
    return NOTHING;
}


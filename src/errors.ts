import { isinstance, javaHash, rotate32 } from "@r47onfire/game-math";
import { NOTHING } from "./define";
import { Identifier } from "./utils";
import { JebVM, pushCommand, pushData } from "./vm";

/**
 * Mapping of error tag to class constructor (used by the `err` function)
 */
export const ALL_ERRORS: Record<string, typeof JEBError> = {};

/**
 * Generic base class for an error thrown by a JEB program.
 */
export class JEBError extends Error {
    /**
     * The name of the error type
     *
     * NOTE: this must be a getter, not a regular instance property, since when the
     * error class is initialized for the first time, the value of `this.tag` is used in the {@link JEBError} constructor
     * to register the tag in the tag-to-class mapping {@link ALL_ERRORS}
     */
    get tag() { return "jeb:runtime_error"; }
    constructor(message: string, public context: Record<string, any> & ErrorOptions = {}, public traceback?: StackTreeNode[]) {
        super(message, { cause: context.cause });
        ALL_ERRORS[this.tag] ??= new.target;
        this.name = this.constructor.name;
    }
    toString() {
        return `(${this.tag}) ${this.message}${this.traceback ? `\nVM stack: ${formatStackTraceCompact(compressStackTree(this.traceback))}` : ""}`
    }
}

/**
 * Variable not found.
 */
export class JEBReferenceError extends JEBError {
    get tag() { return "jeb:reference_error"; }
}

/**
 * Value was correct type but out of range.
 */
export class JEBValueError extends JEBError {
    get tag() { return "jeb:value_error"; }
}

/**
 * Value was wrong type.
 */
export class JEBTypeError extends JEBError {
    get tag() { return "jeb:type_error"; }
}

/**
 * Malformed usage or syntax.
 */
export class JEBSyntaxError extends JEBError {
    get tag() { return "jeb:syntax_error"; }
}

/**
 * Program tried to operate on something previously invalidated.
 */
export class JEBStateError extends JEBError {
    get tag() { return "jeb:state_error"; }
}

/**
 * Too many recursive calls.
 */
export class JEBRecursionError extends JEBError {
    get tag() { return "jeb:recursion_error"; }
}

[
    JEBError,
    JEBReferenceError,
    JEBValueError,
    JEBTypeError,
    JEBStateError,
    JEBRecursionError,
].forEach(e => new e(""));

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
    name: Identifier | undefined;
    location: Identifier | undefined;
    hash: number;
}>;

export const createStackLeafNode = (name: Identifier | undefined, location: Identifier | undefined): StackTreeNode => {
    return { leaf: true, name, location, hash: javaHash(String(name)) ^ (location ? javaHash(String(location)) : 0xDEADBEEF) };
};

export const createStackInnerNode = (count: number, children: StackTreeNode[]): StackTreeNode => {
    return { leaf: false, count, children, hash: children.reduce((prev, { hash }) => rotate32(prev, 17) ^ hash, 0x24354657) };
};

export const compressStackTree = (nodes: StackTreeNode[]): StackTreeNode[] => {
    const len = nodes.length;
    if (len === 0) return [];

    const result: StackTreeNode[] = [];

    for (var i = 0; i < len;) {
        // Find the best repeating pattern starting at position i
        var bestLen = 1, bestCount = 1;

        // Try pattern lengths from 1 to half the remaining array
        const maxPatternLen = ((len - i) / 2) | 0;
        for (var patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
            var repeatCount = 1;

            // Count how many consecutive times this pattern repeats
            while (
                i + patternLen * (repeatCount + 1) <= len &&
                patternsEqual(nodes, i, i + patternLen * repeatCount, patternLen)
            ) repeatCount++;

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
        return node1.name === node2.name && node1.location === node2.location;
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
 * @param nodes The compressed stack tree nodes
 * @returns A formatted string like "foo <- bar <- (baz * 3) <- qux"
 */
export const formatStackTraceCompact = (nodes: StackTreeNode[]): string => {
    return nodes.map(item => item.leaf ? item.name : `(${formatStackTraceCompact(item.children)} * ${item.count})`).join(STACKFRAME_JOINER);
};

/**
 * Runs the function, and if it throws an error that isn't a {@link JEBError},
 * wraps it in the given error type and re-throws it, otherwise returns the function result.
 * @param kind Kind of JEB error a thrown error causes
 * @param f The function to catch errors from
 * @example
 * ```
 * defineBuiltin(vm, "test", null, false, false,
 *     (vm, args) => wrapThrowToError(vm, "test:testError",
 *         () => doSomethingThatMayThrow(vm, args[0])));
 * ```
 */
export const wrapThrowToError = <T>(kind: new (message: string, options: { cause: any }) => JEBError, f: () => T) => {
    try {
        return f();
    } catch (e) {
        if (isinstance(e, JEBError)) throw e;
        throw new kind(String(e), { cause: e });
    }
}

/**
 * Pushes the value to the VM's data stack, but only if the value is not {@link NOTHING}.
 * @param vm VM we're running in
 * @param value Value to check
 */
export const checkNothingOrPush = <T extends JebVM>(vm: T, value: any) => {
    if (value !== NOTHING) vm.pushData(value);
}

/**
 * Pauses the VM while the promise is pending, and then resumes it when it
 * resolves or rejects.
 */
export const promisifyVM = <T extends JebVM, X>(vm: T, promise: Promise<X>): void => {
    vm.paused = true;
    promise.then(
        result => (vm.paused = false, pushData(vm, result)),
        error => (vm.paused = false, pushCommand(vm, () => { throw error; })));
}

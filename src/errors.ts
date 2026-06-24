import { Result, Err, Ok } from "ts-res";
import { NOTHING } from "./builtins/utils";
import { JebVM } from "./vm";

const STACKFRAME_JOINER = "<-";
const MAX_CYCLE_LEN = 32;
const memcmp = (a: string[], aPos: number, bPos: number, len: number): boolean => {
    for (var i = 0; i < len; i++) if (a[aPos + i] !== a[bPos + i]) return false;
    return true;
}
const compress1 = (tokens: string[]): string[] => {
    const out: string[] = [];
    const n = tokens.length;
    var i = 0;

    while (i < n) {
        var bestLen = 0, bestRepeatCount = 1;

        for (var len = 1; len <= MAX_CYCLE_LEN; len++) {
            // quick reject – 2nd possibility of a repeat must match starting here
            if (tokens[i] !== tokens[i + len]) continue;

            var repeats = 1;
            while (memcmp(tokens, i, i + repeats * len, len)) repeats++;
            if (repeats > bestRepeatCount) {
                bestLen = len;
                bestRepeatCount = repeats;
            }
        }

        if (bestRepeatCount > 1) {
            const inner = tokens.slice(i, i + bestLen).join(STACKFRAME_JOINER);
            out.push(`(${inner} * ${bestRepeatCount})`);
            i += bestLen * bestRepeatCount;
        } else {
            out.push(tokens[i++]!);
        }
    }
    return out;
}
const compressStack = (parts: string[]): string => {
    for (var pass = 0; pass < MAX_CYCLE_LEN; pass++) {
        const next = compress1(parts);
        if (next.length >= parts.length) break;
        parts = next;
    }
    return parts.join(STACKFRAME_JOINER);
}
/**
 * Formats the stack nicely and then throws the error
 * @param type type string for the error
 * @param message message of the error
 * @param stack list of stack entries as strings
 */
export const jsError = (type: string, message: string, stack: string[]): never => {
    throw new Error(`(${type}) ${message}\nVM stack: ${compressStack(stack)}`);
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


import { NOTHING } from ".";
import { Result } from "./result";
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
export const jsError = (type: string, message: string, stack: string[]): never => {
    throw new Error(`(${type}) ${message}\nVM stack: ${compressStack(stack)}`);
}
export const resultToError = (vm: JebVM, errType: string, result: Result<any>) => {
    if (result.ok) {
        return result.value;
    }
    vm.pushCommand("jeb:throw", errType, result.value, {
        return: vm.cc(),
    });
    return NOTHING;
}


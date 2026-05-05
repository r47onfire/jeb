import { Continuation } from "./continuation";
import { NOTHING } from ".";
import { Result } from "./result";
import { JebVM } from "./vm";

const STACKFRAME_JOINER = "<-";
const MAX_CYCLE_LEN = 32;
function memcmp(a: string[], aPos: number, bPos: number, len: number): boolean {
    for (var i = 0; i < len; i++) if (a[aPos + i] !== a[bPos + i]) return false;
    return true;
}
function compress1(tokens: string[]): string[] {
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
function compressStack(parts: string[]): string {
    for (var pass = 0; pass < MAX_CYCLE_LEN; pass++) {
        const next = compress1(parts);
        if (next.length >= parts.length) break;
        parts = next;
    }
    return parts.join(STACKFRAME_JOINER);
}
export function jsError(type: string, message: string, stack: string[]): never {
    throw new Error(`(${type}) ${message}\nVM stack: ${compressStack(stack)}`);
}

export function tracebackPush(vm: JebVM, args: any[]) {
    const top = vm.tracebackStack;
    const func = args[0] as string;
    const tailcallHint = args[1] as boolean;
    if (top && top.value === func && top.isTailCalled === tailcallHint) {
        // same name and type = just bump the counter
        vm.tracebackStack = {
            value: func,
            count: top.count + 1,
            next: top.next,
            isTailCalled: tailcallHint
        };
    } else {
        vm.tracebackStack = {
            value: func,
            count: 1,
            next: top,
            isTailCalled: tailcallHint
        };
    }
}
export function tracebackPop(vm: JebVM) {
    var cur = vm.tracebackStack;
    if (!cur) throw new Error("Traceback stack underflow");

    // drop all TCO'ed frames
    while (cur && cur.isTailCalled) {
        cur = cur.next;
    }

    if (!cur) {
        // oops, all tail calls
        vm.tracebackStack = null;
        return;
    }

    // normal frame pop
    if (cur.count > 1) {
        vm.tracebackStack = {
            value: cur.value,
            count: cur.count - 1,
            next: cur.next,
            isTailCalled: false
        };
    } else {
        vm.tracebackStack = cur.next;
    }
}
export function resultToError(vm: JebVM, errType: string, result: Result<any>) {
    if (result.ok) {
        return result.value;
    }
    vm.pushCommand("throw", errType, result.value, {
        return: Continuation.fromVM(vm)
    });
    return NOTHING;
}


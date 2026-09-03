import { OP_eval, OP_shuffle } from "./builtins";
import { NOTHING } from "./define";
import { JebVM } from "./vm";

/**
 * Sets up instructions to run all of the arguments in order and the result is the value of the last one.
 * @param vm VM to evaluate in
 * @param args List of things to evaluate
 * @returns - {@link NOTHING}
 */
export const implicitBegin = (vm: JebVM, args: any[]) => {
    const len = args.length;
    if (len === 0) {
        vm.pushData(null);
    }
    // Evaluate all in order (reverse because stack)
    for (var i = len - 1, last = true; i >= 0; i--, last = false) {
        // Drop all but the last one
        if (!last) vm.pushCommand(OP_shuffle, 1, []);
        vm.pushData(args[i]);
        // Do a tail call on the last item
        vm.pushCommand(OP_eval, undefined, undefined, undefined, last);
    }
    return NOTHING;
};

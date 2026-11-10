import { OP_eval, OP_get, OP_tbPop, OP_tbPush } from ".";
import { makeOpcode } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { DropFirst } from "../utils";
import {
    JebVM,
    peekData,
    popData,
    pushCommand,
    pushData,
    StackEntryKind,
} from "../vm";
import {
    EmptyArg,
    MacroWrapper,
    OptionArg,
    ReferenceWrapper,
    Wrapper,
} from "../wrapper";

/**
 * Argument tuple for {@link OP_wrap}: a {@link Wrapper} subclass constructor
 * plus the extra arguments to pass to it after the value being wrapped.
 */
type WrapArg<T extends new (obj: any, ...args: any[]) => Wrapper> = [
    cls: T,
    ...extraArgs: DropFirst<ConstructorParameters<T>>,
];

export const OP_wrap = makeOpcode(
    "wrap",
    (vm, args: WrapArg<any>) => {
        const item = popData(vm);
        const cls = args[0];
        pushData(vm, new cls(item, ...args.slice(1)));
    },
    `.imm cls args...
.param {constructor function} cls - the class constructor to use - must return instance of \`Wrapper\`
.param {any} args... - the parameters to pass into the constructor after the object
.sed obj -- wrapped
. Wraps the object in the given wrapper class.`,
);
export const OP_unwrap = makeOpcode(
    "unwrap",
    (vm, { 0: flags, 1: only }: [string[], only?: boolean]) => {
        const top = peekData(vm);
        if (!(top instanceof Wrapper)) return;
        const tag = top.flag;
        if (!flags.includes(tag) === !only) {
            popData(vm);
            pushCommand(vm, OP_unwrap, flags, only);
            unwrapValue(vm, top);
        }
    },
    `.imm flags only
.param {string[]} flags
.param {boolean?} [only=false]
.sed value -- unwrapped
. Unwraps all wrappers from the value, when the value's wrapper has a tag in the given list of \`flags\` (when \`only\` is true) or when the value's wrapper has a tag *not* in the list of \`flags\` (when \`only\` is false). A value that is not a wrapper is left alone.`,
);

/**
 * Runs the unwrapping behavior of a wrapper value (already popped by
 * {@link OP_unwrap}, which re-queues itself behind this for the result):
 * each wrapper kind knows how its unwrapped form is produced. Wrapper kinds
 * not listed here have no unwrapping behavior and are consumed elsewhere
 * (argument binding, for the argument wrappers).
 */
const unwrapValue = (vm: JebVM, top: Wrapper) => {
    if (top instanceof ReferenceWrapper) {
        pushCommand(vm, OP_get, true);
        pushData(vm, top.obj);
    } else if (top instanceof MacroWrapper) {
        const { obj } = top;
        const from = vm.lastCall;
        if (from) {
            // The call that just returned is the one that produced this
            // expansion (normally the macro invocation itself). Evaluate
            // the expansion under a frame naming it, at its call site, so
            // that an error thrown by the expanded code mentions the macro
            // even though the macro itself has already returned. The
            // OP_unwrap after the evaluation expands the expansion's
            // own result if it is itself a macro expansion, while the call
            // that produced it is still the last call, so nested expansions
            // get their own frames instead of escaping to an outer
            // consumer; any other wrapper the expansion evaluates to is
            // left for that consumer to unwrap (or not) as it sees fit.
            pushCommand(vm, OP_tbPop);
            pushCommand(vm, OP_unwrap, ["macro"], true);
            pushCommand(vm, OP_eval, from.location);
            pushCommand(
                vm,
                OP_tbPush,
                from.name,
                from.location,
                StackEntryKind.MACRO_EXPANSION_RESULT,
                false,
            );
        } else {
            pushCommand(vm, OP_unwrap, ["macro"], true);
            pushCommand(vm, OP_eval, undefined);
        }
        pushData(vm, obj);
    } else if (top instanceof EmptyArg) {
        throw new JEBError(
            ErrnoCode.EINVAL,
            "there is no parameter to which a default can be forced here",
        );
    } else if (top instanceof OptionArg) {
        throw new JEBError(
            ErrnoCode.EINVAL,
            "there is no parameter with which an option can be used here",
        );
    } else if (top.flag === "hole") {
        // The null-chaining hole (the only "hole"-flagged wrapper) unwraps
        // to the undefined or null it wraps.
        pushData(vm, top.obj);
    }
};

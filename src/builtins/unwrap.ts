import {
    OP_eval,
    OP_get,
    OP_tbPop,
    OP_tbPush,
    pushAccessCall,
    pushMethodApply,
} from ".";
import { Block } from "../block";
import { defineUnwrapper, makeOpcode } from "../define";
import { AccessReference, AccessType, protocolMethod } from "../protocol";
import { PROTOCOL_SYMBOLS } from "../well_known";
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
/**
 * Decides from a resolved tag whether the value on top of the data stack
 * (which `value` is) gets unwrapped: if the tag passes the flag lists, the
 * value is popped and its `unwrap` protocol implementation runs, with
 * another `OP_unwrap` queued behind it for the result.
 */
const unwrapIfTagged = (
    vm: JebVM,
    value: any,
    tag: any,
    flags: string[],
    only?: boolean,
) => {
    if (!flags.includes(tag) === !only) {
        // The tag says the value may be unwrapped here; an unwrapper
        // (a dedicated one, or the value's __unwrap__ method) must also
        // exist -- an accessed object whose __tag__ happens to read as
        // some string is not thereby a wrapper.
        const unwrapper = vm.getProtocol(false, false, "unwrap", [value]);
        if (!unwrapper) return;
        popData(vm);
        pushCommand(vm, OP_unwrap, flags, only);
        unwrapper.run(vm, [value]);
    }
};
/**
 * Continuation of {@link OP_unwrap}'s `__access__` path: the descriptor the
 * access returned is on top of the data stack, over the value it was read
 * from (which is also passed as an immediate). If the descriptor has no
 * `__get__`, the tag simply reads as undefined -- the value is not a
 * wrapper -- so unlike `OP_accessed_get` this is not an error.
 */
const OP_unwrap_get_tag = makeOpcode(
    null,
    (
        vm: JebVM,
        { 0: flags, 1: only, 2: value }: [string[], boolean | undefined, any],
    ) => {
        const descriptor = popData(vm);
        const get = protocolMethod(descriptor, "get");
        if (!get) return;
        pushCommand(vm, OP_unwrap_with_tag, flags, only, value);
        pushCommand(vm, OP_unwrap, []);
        pushMethodApply(vm, get, [descriptor]);
    },
    null,
);
/**
 * Continuation of {@link OP_unwrap} for a tag that had to be read first
 * (through a descriptor's `__get__`, or through `__access__`): the resolved
 * tag is on top of the data stack, over the value it describes (which is
 * also passed as an immediate).
 */
const OP_unwrap_with_tag = makeOpcode(
    null,
    (
        vm: JebVM,
        { 0: flags, 1: only, 2: value }: [string[], boolean | undefined, any],
    ) => {
        const tag = popData(vm);
        // A tag that reads as undefined is no tag at all: the property
        // simply does not exist on the value, so it is not a wrapper.
        if (tag !== undefined) unwrapIfTagged(vm, value, tag, flags, only);
    },
    null,
);
export const OP_unwrap = makeOpcode(
    "unwrap",
    (vm, { 0: flags, 1: only }: [string[], only?: boolean]) => {
        const top = peekData(vm);
        if (typeof top !== "object" || top === null) return;
        // A wrapper says its tag with its __tag__ property (the Wrapper
        // base class provides one, returning the wrapper's flag).
        const tag = top[PROTOCOL_SYMBOLS.tag];
        if (tag !== undefined) {
            if (
                typeof tag === "object" &&
                tag !== null &&
                tag[PROTOCOL_SYMBOLS.get] !== undefined
            ) {
                // The tag is behind a descriptor: read it, then decide.
                pushCommand(vm, OP_unwrap_with_tag, flags, only, top);
                pushCommand(vm, OP_unwrap, []);
                pushCommand(vm, OP_get, true);
                pushData(vm, tag);
                return;
            }
            unwrapIfTagged(vm, top, tag, flags, only);
            return;
        }
        // No direct __tag__: the tag can still live behind __access__,
        // but only a value that also provides __unwrap__ can be a
        // wrapper at all. Any other accessed object is not probed: it is
        // under no obligation to have a __tag__ (the hole's reads all
        // return the hole itself, so probing it would never terminate).
        if (
            top[PROTOCOL_SYMBOLS.unwrap] !== undefined &&
            protocolMethod(top, "access")
        ) {
            const ref = new AccessReference(
                AccessType.PROPERTY,
                top,
                new Block(vm.currentEnv, [["sym", "__tag__"]]),
            );
            pushCommand(vm, OP_unwrap_get_tag, flags, only, top);
            pushCommand(vm, OP_unwrap, []);
            pushAccessCall(vm, ref);
        }
    },
    `.imm flags only
.param {string[]} flags
.param {boolean?} [only=false]
.sed value -- unwrapped
. Unwraps all wrappers from the value, when the value's wrapper has a tag in the given list of \`flags\` (when \`only\` is true) or when the value's wrapper has a flag *not* in the list of \`flags\` (when \`only\` is false). The tag is the value's \`__tag__\` property, read through \`__access__\` / \`__get__\` if it is not a direct property; a value with no tag is not a wrapper and is left alone.`,
);

export const loadUnwrappingBuiltins = (vm: JebVM) => {
    defineUnwrapper(
        vm,
        [ReferenceWrapper],
        (vm, { 0: { obj } }) => {
            pushCommand(vm, OP_get, true);
            pushData(vm, obj);
        },
        "Unwraps a reference",
    );
    defineUnwrapper(
        vm,
        [MacroWrapper],
        (vm, { 0: { obj } }) => {
            const from = vm.lastCall;
            if (from) {
                // The call that just returned is the one that produced this
                // expansion (normally the macro invocation itself). Evaluate
                // the expansion under a frame naming it, at its call site, so
                // that an error thrown by the expanded code mentions the macro
                // even though the macro itself has already returned. The
                // OP_unwrap_macro after the evaluation expands the expansion's
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
        },
        "Unwraps a macro expansion thing",
    );
    defineUnwrapper(
        vm,
        [EmptyArg],
        () => {
            throw new JEBError(
                ErrnoCode.EINVAL,
                "there is no parameter to which a default can be forced here",
            );
        },
        "Unwraps an empty arg placeholder (by throwing an error)",
    );
    defineUnwrapper(
        vm,
        [OptionArg],
        () => {
            throw new JEBError(
                ErrnoCode.EINVAL,
                "there is no parameter with which an option can be used here",
            );
        },
        "Unwraps an option arg placeholder (by throwing an error)",
    );
};

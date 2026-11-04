import { Block } from "../block";
import {
    define,
    defineAccessor,
    makeJSFun,
    makeOpcode,
    NOTHING,
} from "../define";
import { Env } from "../env";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { implicitBegin } from "../implicitBegin";
import {
    AccessReference,
    AccessType,
    protocolMethod,
    Reference,
} from "../protocol";
import { Laziness } from "../signature";
import { theTypeName, typeOf, withType } from "../typecheck";
import { Identifier } from "../utils";
import { JebVM, peekData, popData, pushCommand, pushData } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import {
    accessedSetter,
    OP_apply,
    OP_assign,
    OP_get,
    OP_index,
    OP_shuffle,
    pushAccessCall,
    pushMethodApply,
} from "./eval";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { OP_unwrap, OP_wrap } from "./unwrap";

// MARK: variables
const accessorInit = (vm: JebVM) => {
    defineAccessor(
        vm,
        ["object", "function"],
        (_, { 0: object }, { field, type }) =>
            new ObjectPropertyReference(type, object, field),
        "Default object property accessor.",
    );
    defineAccessor(
        vm,
        [Env],
        (_, { 0: env }, { field, type }) =>
            new VariableReference(type, env, field as Identifier),
        "Accessor for variables from an environment.",
    );
};
export const B_local = makeJSFun(
    "local",
    ["name"],
    ({ name }, vm) => {
        pushCommand(vm, OP_wrap, ReferenceWrapper);
        pushCommand(vm, OP_index, AccessType.VARIABLE);
        pushData(vm, vm.currentEnv);
        return name;
    },
    `.func (local name)
..param {string} name
.pure
.throws ENAME - if the name is not defined anywhere
.returns {any}
. Look up the variable with this name in the current environment.`,
);
export const B_index = makeJSFun(
    "index",
    ["obj", [false, "name"]],
    ({ obj, name }, vm) => {
        const key = name as Block;
        if (protocolMethod(obj, "access")) {
            // The object controls indexing itself through __access__:
            // keep the key unevaluated, so the method's signature
            // decides whether it is evaluated (see AccessReference).
            pushCommand(vm, OP_wrap, ReferenceWrapper);
            pushCommand(vm, OP_push_value, new AccessReference(obj, key));
            return NOTHING;
        }
        pushCommand(vm, OP_wrap, ReferenceWrapper);
        pushCommand(vm, OP_index, AccessType.PROPERTY);
        // The key is evaluated like a call argument: its result is
        // unwrapped (an inner index's reference reads through).
        pushCommand(vm, OP_unwrap, ["splat", "keyword", "empty", "option"]);
        pushCommand(vm, OP_block_invoke, key, false);
        pushCommand(vm, OP_push_value, { _: {} });
        pushData(vm, obj);
        return NOTHING;
    },
    `.func (index obj name)
..param {any} obj
..param {PropertyKey} name
.pure
. Returns a reference to \`obj[name]\`. If \`obj\` has an \`__access__\` protocol method, the key is passed to it unevaluated and the method's signature decides whether it is evaluated. Nothing else is consulted: without \`__access__\` the object is indexed as an ordinary object, and any \`__get__\`/\`__set__\` methods it has are just properties.`,
);
const OP_assign_internal_nested = makeOpcode(
    null,
    (vm) => pushData(vm, { _: { _: popData(vm) } }),
    null,
);
const OP_assign_internal = makeOpcode(
    null,
    (vm: JebVM, { 0: b, 1: old }: [Block, boolean]) => {
        // accessor is first on stack
        if (old) pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_assign);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_block_invoke, b, false);
        pushCommand(vm, OP_assign_internal_nested);
        if (old) pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
        pushCommand(vm, OP_get, true);
        pushCommand(vm, OP_shuffle, 1, [0, 0]);
    },
    null,
);
/** Pushes an already-computed value onto the data stack as a command. */
export const OP_push_value = makeOpcode(
    null,
    (vm: JebVM, { 0: value }: [any]) => pushData(vm, value),
    null,
);
/**
 * Calls a descriptor's `__set__` method with the value on top of the data
 * stack, leaving the value there (like the `assign` opcode does for
 * references).
 */
const OP_desc_set = makeOpcode(
    null,
    (vm: JebVM, { 0: target }: [any]) => {
        const set = protocolMethod(target, "set")!;
        pushMethodApply(vm, set, [target, peekData(vm)], true);
    },
    null,
);
/**
 * The descriptor counterpart of {@link OP_assign_internal}: reads the old value
 * through the descriptor's `__get__` method (`undefined` if it has none),
 * evaluates the value block with `_` bound to it, and assigns the result
 * through `__set__`.
 */
const OP_assign_descriptor_internal = makeOpcode(
    null,
    (vm: JebVM, { 0: target, 1: b, 2: old }: [any, Block, boolean]) => {
        pushCommand(vm, OP_shuffle, 2, [old ? 0 : 1]);
        pushCommand(vm, OP_desc_set, target);
        pushCommand(vm, OP_block_invoke, b, false);
        pushCommand(vm, OP_assign_internal_nested);
        pushCommand(vm, OP_shuffle, 1, [0, 0]);
        const get = protocolMethod(target, "get");
        if (get) {
            pushCommand(vm, OP_unwrap, []);
            pushMethodApply(vm, get, [target]);
        } else pushCommand(vm, OP_push_value, undefined);
    },
    null,
);
/**
 * Schedules an assignment to a descriptor: an object with a `__set__` protocol
 * method, called as `__set__(obj, value)`.
 *
 * If the method's value parameter is lazy, the unevaluated right-hand side
 * expression is passed straight to the method (through `OP_apply`, so its
 * signature does the binding): if the method never evaluates it, the right-hand
 * side never runs, and the assignment returns the method's own result (or the
 * old value, read through `__get__` first, if that was requested). Otherwise
 * the value block is evaluated with `_` bound to the old value, as for
 * references, and the assignment returns the new or old value.
 */
const assignDescriptor = (
    vm: JebVM,
    target: any,
    set: any,
    value: Block,
    wantOld: boolean,
) => {
    const { signature } = vm
        .getProtocol(true, true, "apply", [set])
        .describe(vm, set);
    const valueParam = signature[1];
    if (valueParam && valueParam.lazy !== Laziness.NONE) {
        if (wantOld) pushCommand(vm, OP_shuffle, 1, []); // the __set__ result is dropped
        // The descriptor is an already-computed value; the value
        // expression goes verbatim, for the method's signature to
        // evaluate (or not).
        pushData(vm, set);
        pushCommand(vm, OP_apply, [target, value.body[0]], undefined, false, [
            true,
            false,
        ]);
        if (wantOld) {
            const get = protocolMethod(target, "get");
            if (get) {
                pushCommand(vm, OP_unwrap, []);
                pushMethodApply(vm, get, [target]);
            } else pushCommand(vm, OP_push_value, undefined);
        }
        return;
    }
    pushCommand(vm, OP_assign_descriptor_internal, target, value, wantOld);
};
/**
 * Continuation of an assignment through an {@link AccessReference} from the
 * `assign` builtin: the descriptor object returned by `__access__` is on top of
 * the data stack; assign to it as a bare descriptor (see
 * {@link assignDescriptor}). Unlike `OP_accessed_set` (the `assign` opcode's
 * continuation in eval.ts), the value here is still the unevaluated right-hand
 * side expression, so the descriptor's `__set__` signature decides whether it
 * is evaluated.
 */
const OP_assign_accessed = makeOpcode(
    null,
    (
        vm: JebVM,
        {
            0: value,
            1: wantOld,
            2: property,
        }: [Block, boolean, string | undefined],
    ) => {
        const descriptor = popData(vm);
        assignDescriptor(
            vm,
            descriptor,
            accessedSetter(descriptor, property),
            value,
            wantOld,
        );
    },
    null,
);
export const B_assign = makeJSFun(
    "assign",
    [
        [["ref"], "ref"],
        [false, "value"],
        ["old", false],
    ],
    (args, vm) => {
        const { ref, value, old } = args;
        const wantOld = withType(old, ["boolean"], "old", args);
        if (ref instanceof ReferenceWrapper) {
            if (ref.obj instanceof AccessReference) {
                pushCommand(
                    vm,
                    OP_assign_accessed,
                    value as Block,
                    wantOld,
                    ref.obj.propertyName,
                );
                pushCommand(vm, OP_unwrap, []);
                pushAccessCall(vm, ref.obj);
                return NOTHING;
            }
            pushCommand(vm, OP_assign_internal, value as Block, wantOld);
            return ref.obj;
        }
        if (ref instanceof AccessReference) {
            // A bare access reference (e.g. out of (ref (index obj k))):
            // the same access step as for a wrapped one.
            pushCommand(
                vm,
                OP_assign_accessed,
                value as Block,
                wantOld,
                ref.propertyName,
            );
            pushCommand(vm, OP_unwrap, []);
            pushAccessCall(vm, ref);
            return NOTHING;
        }
        const set = protocolMethod(ref, "set");
        if (set) {
            assignDescriptor(vm, ref, set, value as Block, wantOld);
            return NOTHING;
        }
        throw new JEBError(
            ErrnoCode.EINVAL,
            `cannot assign to ${theTypeName(typeOf(ref))}`,
        );
    },
    `.macro (assign slot value old)
..param {reference | descriptor} slot
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
.throws ENAME - if the value is not defined anywhere
.returns {old ? U : T}
. Changes the value of the slot, and returns the new or old value as determined by \`old\`.
. The slot may also be a descriptor (an object with a \`__set__\` protocol method, or a descriptor returned by an \`__access__\` method): the assignment then calls that method instead. If the method's value parameter is lazy it receives the value unevaluated, and the assignment returns the method's result instead.`,
);

export const B_ref = makeJSFun(
    "ref",
    [[["ref"], "ref"]],
    (args) => {
        if (args.ref instanceof ReferenceWrapper) return args.ref.obj;
        if (args.ref instanceof AccessReference) return args.ref;
        if (protocolMethod(args.ref, "get") ?? protocolMethod(args.ref, "set"))
            // A descriptor object is its own reference.
            return args.ref;
        return withType(args.ref, [ReferenceWrapper], "ref", args).obj;
    },
    `.macro (ref x)
..param {[assignable location]} x
.pure
. Asserts that \`x\` is a valid assignable, and then returns a reference to it, which can be assigned to or read with [[deref]].
. A descriptor (an object with \`__get__\`/\`__set__\` protocol methods) is its own reference, and is returned as-is.`,
);

export const B_deref = makeJSFun(
    "deref",
    ["ref"],
    (args) => {
        if (args.ref instanceof Reference)
            return new ReferenceWrapper(args.ref);
        if (protocolMethod(args.ref, "get"))
            return new ReferenceWrapper(args.ref);
        return new ReferenceWrapper(
            withType(args.ref, [Reference], "ref", args),
        );
    },
    `.func (deref x)
..param {Reference | descriptor} x
.pure
. Asserts that \`x\` is a valid reference value created by [[ref]], and then returns the value stored in the reference.
. A descriptor (an object with a \`__get__\` protocol method) may be given instead of a reference; the value read through it is returned.
This function works with [[assign]] to be able to change the value of the reference as well.`,
);

export const B_always = makeJSFun(
    "always",
    ["derived", [false, "onchange"], [["ref"], 0, "refs"]],
    (args, vm) => {
        const { derived, onchange, refs } = args;
        const watches: (() => void)[] = [];
        if (refs!.length < 1)
            throw new JEBError(
                ErrnoCode.EINVAL,
                "need at least 1 variable to watch",
            );
        for (var i = 0; i < refs!.length; i++) {
            const ref = refs![i]!;
            // TODO: how to reference the bad parameter in traceback?
            if (!(ref instanceof ReferenceWrapper)) {
                throw new JEBError(ErrnoCode.EINVAL, "not a reference");
            }
            const slot = ref.obj;
            if (!(slot instanceof VariableReference)) {
                throw new JEBError(ErrnoCode.EINVAL, "can't watch this slot");
            }
            slot.env
                .scopeFor(slot.name)
                .and((env) => {
                    if (env.constants[slot.name])
                        throw new JEBError(
                            ErrnoCode.EROFS,
                            "can't watch a constant",
                        );
                    watches.push(
                        env.watch(slot.name, onchange as any as Block),
                    );
                })
                .else(() => slot.referenceError());
        }
        const shouldRunInitially = withType(
            derived,
            ["boolean"],
            "derived",
            args,
        );
        if (shouldRunInitially) {
            pushCommand(vm, OP_shuffle, 1, []);
            pushCommand(vm, OP_apply, [], undefined, false);
        }
        pushData(vm, () => watches.forEach((w) => w()));
        if (shouldRunInitially) pushData(vm, onchange);
        return NOTHING;
    },
    `.func (always block vars...)
..param {Block} ^block
..param {VariableReference} vars
..returns {() => void} function that will cancel the watching of all referenced variables
. Sets up \`block\` to be run whenever any of the \`vars\` are reassigned (even if the new value is the same as the old value).
Note: don't watch any variable the handler block assigns, otherwise you'll get an infinite loop.`,
);

export const OP_block_invoke = makeOpcode(
    null,
    (vm: JebVM, { 0: b, 1: tail }: [Block, boolean | undefined]) => {
        if (!tail) pushCommand(vm, OP_set_env, vm.currentEnv);
        const env = (vm.currentEnv = vm.createEnv(b.closureEnv));
        const injected = popData(vm)._,
            names = Reflect.ownKeys(injected);
        for (var i = names.length; i >= 0; i--)
            env.add(names[i]!, injected[names[i]!]);
        implicitBegin(vm, b.body);
    },
    null,
);
export const OP_set_env = makeOpcode(
    "set_env",
    (vm: JebVM, { 0: env }: [Env]) => (vm.currentEnv = env),
    `.imm env
..param {Env} env - Environment to set
. Switches the current environment to the one given.
Used by the block invocation mechanism to restore the caller's environment after a call.`,
);

/**
 * Registers this file's builtins in the VM's builtins scope, in the order
 * listed. Called by {@link loadBuiltins}.
 */
export const loadVariablesBuiltins = (vm: JebVM) => {
    define(vm, "local", B_local);
    define(vm, "index", B_index);
    define(vm, "assign", B_assign);
    define(vm, "ref", B_ref);
    define(vm, "deref", B_deref);
    define(vm, "always", B_always);
    accessorInit(vm);
};

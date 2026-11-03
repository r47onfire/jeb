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
    AccessType,
    DescriptorReference,
    protocolMethod,
    Reference,
} from "../protocol";
import { Laziness } from "../signature";
import { theTypeName, typeOf, withType } from "../typecheck";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { OP_unwrap, OP_wrap } from "./unwrap";
import { Identifier } from "../utils";
import { JebVM, peekData, popData, pushCommand, pushData } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import {
    OP_apply,
    OP_get,
    OP_index,
    OP_assign,
    OP_shuffle,
    pushMethodCall,
} from "./eval";

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
    ["obj", "name"],
    ({ obj, name }, vm) => {
        pushCommand(vm, OP_wrap, ReferenceWrapper);
        pushCommand(vm, OP_index, AccessType.PROPERTY);
        pushData(vm, obj);
        return name;
    },
    `.func (index obj name)
..param {any} obj
..param {PropertyKey} name
.pure
. Returns a reference to \`obj[name]\`.`,
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
const OP_push_value = makeOpcode(
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
    (
        vm: JebVM,
        {
            0: target,
            1: field,
            2: hasField,
        }: [any, PropertyKey | undefined, boolean],
    ) => {
        const set = protocolMethod(target, "set")!;
        if (
            !pushMethodCall(
                vm,
                set,
                hasField
                    ? [target, field, peekData(vm)]
                    : [target, peekData(vm)],
                true,
            )
        )
            throw new JEBError(
                ErrnoCode.EINVAL,
                "__set__ method is not callable",
            );
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
    (
        vm: JebVM,
        {
            0: target,
            1: field,
            2: hasField,
            3: b,
            4: old,
        }: [any, PropertyKey | undefined, boolean, Block, boolean],
    ) => {
        pushCommand(vm, OP_shuffle, 2, [old ? 0 : 1]);
        pushCommand(vm, OP_desc_set, target, field, hasField);
        pushCommand(vm, OP_block_invoke, b, false);
        pushCommand(vm, OP_assign_internal_nested);
        pushCommand(vm, OP_shuffle, 1, [0, 0]);
        const get = protocolMethod(target, "get");
        if (get) {
            pushCommand(vm, OP_unwrap, []);
            if (!pushMethodCall(vm, get, hasField ? [target, field] : [target]))
                throw new JEBError(
                    ErrnoCode.EINVAL,
                    "__get__ method is not callable",
                );
        } else pushCommand(vm, OP_push_value, undefined);
    },
    null,
);
/**
 * Schedules an assignment to a descriptor: an object with a `__set__` protocol
 * method, either the object itself (a cell, called as `__set__(obj, value)`) or
 * one of its fields through a {@link DescriptorReference} (`__set__(obj, field,
 * value)`).
 *
 * If the method's value parameter is lazy, the unevaluated value block is
 * handed to the method as-is: if the method never evaluates it, the right-hand
 * side never runs, and the assignment returns the method's own result (or the
 * old value, read through `__get__` first, if that was requested). Otherwise
 * the value block is evaluated with `_` bound to the old value, as for
 * references, and the assignment returns the new or old value.
 */
const assignDescriptor = (
    vm: JebVM,
    target: any,
    field: PropertyKey | undefined,
    hasField: boolean,
    value: Block,
    wantOld: boolean,
) => {
    const set = protocolMethod(target, "set")!;
    const { signature } = vm
        .getProtocol(true, true, "apply", [set])
        .describe(vm, set);
    const valueParam = signature[hasField ? 2 : 1];
    if (valueParam && valueParam.lazy !== Laziness.NONE) {
        const selfAndField = hasField ? [target, field] : [target];
        if (!pushMethodCall(vm, set, [...selfAndField, value], wantOld))
            throw new JEBError(
                ErrnoCode.EINVAL,
                "__set__ method is not callable",
            );
        if (wantOld) {
            const get = protocolMethod(target, "get");
            if (get) {
                pushCommand(vm, OP_unwrap, []);
                if (!pushMethodCall(vm, get, selfAndField))
                    throw new JEBError(
                        ErrnoCode.EINVAL,
                        "__get__ method is not callable",
                    );
            } else pushCommand(vm, OP_push_value, undefined);
        }
        return;
    }
    pushCommand(
        vm,
        OP_assign_descriptor_internal,
        target,
        field,
        hasField,
        value,
        wantOld,
    );
};
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
            if (ref.obj instanceof DescriptorReference) {
                assignDescriptor(
                    vm,
                    ref.obj.obj,
                    ref.obj.field,
                    true,
                    value as Block,
                    wantOld,
                );
                return NOTHING;
            }
            pushCommand(vm, OP_assign_internal, value as Block, wantOld);
            return ref.obj;
        }
        if (protocolMethod(ref, "set")) {
            assignDescriptor(
                vm,
                ref,
                undefined,
                false,
                value as Block,
                wantOld,
            );
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
. The slot may also be a descriptor (an object with a \`__set__\` protocol method, or a field of one): the assignment then calls that method instead. If the method's value parameter is lazy it receives the value unevaluated, and the assignment returns the method's result instead.`,
);

export const B_ref = makeJSFun(
    "ref",
    [[["ref"], "ref"]],
    (args) => {
        if (args.ref instanceof ReferenceWrapper) return args.ref.obj;
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

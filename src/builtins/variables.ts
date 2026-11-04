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
import { checkNothingOrPush, JEBError } from "../errors";
import { implicitBegin } from "../implicitBegin";
import { AccessReference, AccessType, protocolMethod } from "../protocol";
import { theTypeName, typeOf, withType } from "../typecheck";
import { Identifier } from "../utils";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import { OP_apply, OP_assign, OP_index, OP_shuffle } from "./eval";
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
/**
 * The old-value read of {@link OP_assign_internal}: the `get` protocol, except
 * that an lvalue no implementation can read (a descriptor with a `__set__` but
 * no `__get__`) reads as `undefined` instead of throwing.
 */
const OP_assign_get_old = makeOpcode(
    null,
    (vm: JebVM) => {
        const lvalue = popData(vm);
        const getter = vm.getProtocol(true, false, "get", [lvalue]);
        if (!getter) pushData(vm, undefined);
        else
            checkNothingOrPush(
                vm,
                getter.run(vm, [lvalue], { shouldBind: true }),
            );
    },
    null,
);
/**
 * The shared body of an unevaluated assignment (the `assign` builtin's
 * right-hand side, still a block): the lvalue is first on the stack; its old
 * value is read through the `get` protocol, the block is evaluated with `_`
 * bound to it, and the result is assigned through the `set` protocol -- so it
 * works unchanged for references, descriptors, and access references alike. The
 * `set` implementations seed it when their flags say the value is unevaluated
 * (and their own signature does not take the value unevaluated itself).
 */
export const OP_assign_internal = makeOpcode(
    null,
    (vm: JebVM, { 0: b, 1: old }: [Block, boolean]) => {
        // accessor is first on stack
        if (old) pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_assign);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_block_invoke, b, false);
        pushCommand(vm, OP_assign_internal_nested);
        if (old) pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
        pushCommand(vm, OP_assign_get_old);
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
        // Everything else is the set protocol's business: which
        // implementation matches the lvalue (a reference, a descriptor,
        // an access reference) decides how the unevaluated value is
        // handled -- the implementations see it in their flags.
        const lvalue = ref instanceof ReferenceWrapper ? ref.obj : ref;
        const setter = vm.getProtocol(true, false, "set", [lvalue, value]);
        if (!setter)
            throw new JEBError(
                ErrnoCode.EINVAL,
                `cannot assign to ${theTypeName(typeOf(lvalue))}`,
            );
        setter.run(vm, [lvalue, value], {
            create: false,
            readonly: false,
            unevaluated: true,
            old: wantOld,
        });
        return NOTHING;
    },
    `.macro (assign slot value old)
..param {reference | descriptor} slot
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
.throws ENAME - if the value is not defined anywhere
.returns {old ? U : T}
. Changes the value of the slot, and returns the new or old value as determined by \`old\`.
The slot may also be a descriptor (an object with a \`__set__\` protocol method, or a descriptor returned by an \`__access__\` method): the assignment then goes through the \`set\` protocol to that method instead. If the method's value parameter is lazy it receives the value unevaluated, and the assignment returns the method's result instead.`,
);

export const B_ref = makeJSFun(
    "ref",
    [[["ref"], "ref"]],
    ({ ref }) => {
        if (ref instanceof ReferenceWrapper) return ref.obj;
        if (protocolMethod(ref, "get") ?? protocolMethod(ref, "set"))
            // A descriptor object is its own reference.
            return ref;
        throw new JEBError(
            ErrnoCode.EINVAL,
            `${theTypeName(typeOf(ref))} is not a reference`,
        );
    },
    `.macro (ref x)
..param {[assignable location]} x
.pure
. Asserts that \`x\` is a valid assignable, and then returns a reference to it, which can be assigned to or read with [[deref]].
A descriptor (an object with \`__get__\`/\`__set__\` protocol methods) is its own reference, and is returned as-is.`,
);

export const B_deref = makeJSFun(
    "deref",
    ["ref"],
    ({ ref }) => new ReferenceWrapper(ref),
    `.func (deref x)
..param {Reference | descriptor} x
.pure
. Asserts that \`x\` is a valid reference value created by [[ref]], and then returns the value stored in the reference.
A descriptor (an object with a \`__get__\` protocol method) may be given instead of a reference; the value read through it is returned.
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
            // TODO: how to reference a bad rest parameter in traceback?
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

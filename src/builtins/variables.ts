import { Block } from "../block";
import { define, makeJSFun, makeOpcode, NOTHING } from "../define";
import { Env } from "../env";
import { ErrnoCode } from "../errno";
import { checkNothingOrPush, JEBError } from "../errors";
import { implicitBegin } from "../implicitBegin";
import { AccessType, Reference } from "../reference";
import { theTypeName, typeOf, withType } from "../typecheck";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import { pushSyntheticCall } from "./callables";
import { OP_assign, OP_index, OP_shuffle, runSetter } from "./eval";
import { VariableReference } from "./reference";
import { OP_unwrap, OP_wrap } from "./unwrap";

// MARK: variables
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
    [
        [["hole"], "obj"],
        [false, "name"],
    ],
    ({ obj, name }, vm) => {
        const key = name as Block;
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
. Returns a reference to \`obj[name]\`.`,
);
const OP_assign_internal_nested = makeOpcode(
    null,
    (vm) => pushData(vm, { _: { _: popData(vm) } }),
    null,
);
/**
 * The old-value read of {@link OP_assign_internal}: reads the reference,
 * except that an lvalue that is not a reference reads as `undefined` instead
 * of throwing.
 */
const OP_assign_get_old = makeOpcode(
    null,
    (vm: JebVM) => {
        const lvalue = popData(vm);
        if (lvalue instanceof Reference)
            checkNothingOrPush(vm, lvalue.get(vm, true));
        else pushData(vm, undefined);
    },
    null,
);
/**
 * The shared body of an unevaluated assignment (the `assign` builtin's
 * right-hand side, still a block): the lvalue is first on the stack; its old
 * value is read, the block is evaluated with `_` bound to it, and the result
 * is assigned. {@link runSetter} seeds it when an assignment's flags say the
 * value is unevaluated.
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
        [["ref", "hole"], "ref"],
        [false, "value"],
        ["old", false],
    ],
    (args, vm) => {
        const { ref, value, old } = args;
        const wantOld = withType(old, ["boolean"], "old", args);
        // Everything else is runSetter's business: how the lvalue
        // (a reference, or the null-chaining hole) handles the
        // unevaluated value is decided there, from the flags.
        const lvalue = ref instanceof ReferenceWrapper ? ref.obj : ref;
        runSetter(vm, lvalue, value, {
            create: false,
            readonly: false,
            unevaluated: true,
            old: wantOld,
        });
        return NOTHING;
    },
    `.macro (assign slot value old)
..param {reference} slot
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
.throws ENAME - if the value is not defined anywhere
.returns {old ? U : T}
. Changes the value of the slot, and returns the new or old value as determined by \`old\`.
`,
);

export const B_ref = makeJSFun(
    "ref",
    [[["ref"], "ref"]],
    ({ ref }) => {
        if (ref instanceof ReferenceWrapper) return ref.obj;
        throw new JEBError(
            ErrnoCode.EINVAL,
            `${theTypeName(typeOf(ref))} is not a reference`,
        );
    },
    `.macro (ref x)
..param {[assignable location]} x
.pure
. Asserts that \`x\` is a valid assignable, and then returns a reference to it, which can be assigned to or read with [[deref]].`,
);

export const B_deref = makeJSFun(
    "deref",
    ["ref"],
    ({ ref }) => new ReferenceWrapper(ref),
    `.func (deref x)
..param {Reference} x
.pure
. Asserts that \`x\` is a valid reference value created by [[ref]], and then returns the value stored in the reference.
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
        pushData(vm, () => watches.forEach((w) => w()));
        if (shouldRunInitially) pushSyntheticCall(vm, onchange, [], true);
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
};

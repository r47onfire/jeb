import { Block } from "../block";
import { define, defineAccessor, makeJSFun, makeOpcode, NOTHING } from "../define";
import { Env } from "../env";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { implicitBegin } from "../implicitBegin";
import { AccessType, Reference, theTypeName, typeOf, withType } from "../protocol";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { OP_wrap } from "./unwrap";
import { Identifier } from "../utils";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { ReferenceWrapper } from "../wrapper";
import { OP_apply, OP_get, OP_index, OP_set, OP_shuffle } from "./eval";

// MARK: variables
const accessorInit = (vm: JebVM) => {
    defineAccessor(vm, ["object", "function"], (_, { 0: object }, { field, type }) => new ObjectPropertyReference(type, object, field), "Default object property accessor.");
    defineAccessor(vm, [Env], (_, { 0: env }, { field, type }) => new VariableReference(type, env, field as Identifier), "Accessor for variables from an environment.");
};
export const B_local = makeJSFun("local", ["name"], ({ name }, vm) => {
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
. Look up the variable with this name in the current environment.`);
export const B_index = makeJSFun("index", ["obj", "name"], ({ obj, name }, vm) => {
    pushCommand(vm, OP_wrap, ReferenceWrapper);
    pushCommand(vm, OP_index, AccessType.PROPERTY);
    pushData(vm, obj);
    return name;
},
    `.func (index obj name)
..param {any} obj
..param {PropertyKey} name
.pure
. Returns a reference to \`obj[name]\`.`);
const OP_set_internal_nested = makeOpcode(null, vm => pushData(vm, { _: { _: popData(vm) } }), null);
const OP_set_internal = makeOpcode(null, (vm: JebVM, { 0: b, 1: old }: [Block, boolean]) => {
    // accessor is first on stack
    if (old) pushCommand(vm, OP_shuffle, 1, []);
    pushCommand(vm, OP_set);
    pushCommand(vm, OP_shuffle, 2, [1, 0]);
    pushCommand(vm, OP_block_invoke, b, false);
    pushCommand(vm, OP_set_internal_nested);
    if (old) pushCommand(vm, OP_shuffle, 2, [1, 0, 1]);
    pushCommand(vm, OP_get, true);
    pushCommand(vm, OP_shuffle, 1, [0, 0]);
}, null);
export const B_set = makeJSFun("set", [[["ref"], "ref"], [false, "value"], ["old", false]], ({ ref, value, old }, vm) => {
    if (!(ref instanceof ReferenceWrapper)) {
        throw new JEBError(ErrnoCode.EINVAL, `cannot assign to ${theTypeName(typeOf(ref))}`);
    }
    pushCommand(vm, OP_set_internal, value as Block, withType(old, ["boolean"], "old"));
    return ref.obj;
},
    `.macro (set slot value old)
..param {reference} slot
..param {T} value
...injected {U} _ - old value of field
..param {boolean?} [old=false]
.throws ENAME - if the value is not defined anywhere
.returns {old ? U : T}
. Changes the value of the slot, and returns the new or old value as determined by \`old\`.`);

export const B_ref = makeJSFun("ref", [[["ref"], "ref"]], ({ ref }) => withType(ref, [ReferenceWrapper]).obj,
    `.macro (ref x)
..param {[assignable location]} x
.pure
. Asserts that \`x\` is a valid assignable, and then returns a reference to it, which can be assigned to or read with [[deref]].`);

export const B_deref = makeJSFun("deref", ["ref"], ({ ref }) => new ReferenceWrapper(withType(ref, [Reference])),
    `.func (deref x)
..param {Reference} x
.pure
. Asserts that \`x\` is a valid reference value created by [[ref]], and then returns the value stored in the reference.
This function works with [[set]] to be able to change the value of the reference as well.`);

export const B_always = makeJSFun("always", ["derived", [false, "onchange"], [["ref"], "refs"], true], ({ derived, onchange, refs }, vm) => {
    const watches: (() => void)[] = [];
    if (refs!.length < 1) throw new JEBError(ErrnoCode.EINVAL, "need at least 1 variable to watch");
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
        slot.env.scopeFor(slot.name).and(env => {
            if (env.constants[slot.name]) throw new JEBError(ErrnoCode.EROFS, "can't watch a constant");
            watches.push(env.watch(slot.name, onchange as any as Block));
        }).else(() => slot.referenceError());
    }
    const shouldRunInitially = withType(derived, ["boolean"], "derived");
    if (shouldRunInitially) {
        pushCommand(vm, OP_shuffle, 1, []);
        pushCommand(vm, OP_apply, [], undefined, false);
    }
    pushData(vm, () => watches.forEach(w => w()));
    if (shouldRunInitially) pushData(vm, onchange);
    return NOTHING;
},
    `.func (always block vars...)
..param {Block} ^block
..param {VariableReference} vars
..returns {() => void} function that will cancel the watching of all referenced variables
. Sets up \`block\` to be run whenever any of the \`vars\` are reassigned (even if the new value is the same as the old value).
Note: don't watch any variable the handler block assigns, otherwise you'll get an infinite loop.`);

export const OP_block_invoke = makeOpcode(null, (vm: JebVM, { 0: b, 1: tail }: [Block, boolean | undefined]) => {
    if (!tail) pushCommand(vm, OP_set_env, vm.currentEnv);
    const env = vm.currentEnv = vm.createEnv(b.closureEnv);
    const injected = popData(vm)._, names = Reflect.ownKeys(injected);
    for (var i = names.length; i >= 0; i--) env.add(names[i]!, injected[names[i]!]);
    implicitBegin(vm, b.body);
}, null);
export const OP_set_env = makeOpcode("set_env", (vm: JebVM, { 0: env }: [Env]) => vm.currentEnv = env,
    `.imm env
..param {Env} env - Environment to set
. Switches the current environment to the one given.
Used by the block invocation mechanism to restore the caller's environment after a call.`);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadVariablesBuiltins = (vm: JebVM) => {
    define(vm, "local", B_local);
    define(vm, "index", B_index);
    define(vm, "set", B_set);
    define(vm, "ref", B_ref);
    define(vm, "deref", B_deref);
    define(vm, "always", B_always);
    accessorInit(vm);
};

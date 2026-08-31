import { stringify } from "lib0/json";
import { JSFun } from "./callable";
import { AccessFlags, ApplyFlags, ApplyMetadata, EvalFlags, ProtocolObj, Reference, Type } from "./protocol";
import { CallableSignatureFromShorthand, createSignature, ShorthandArgument } from "./signature";
import { JebVM, OpcodeFunction } from "./vm";
import { Wrapper } from "./wrapper";

/**
 * Special symbol to represent 'no value' in contexts where `undefined` is a valid value.
 */
export const NOTHING = Symbol("NOTHING");

/**
 * Creates a builtin function.
 * @param signature Defines the parameters of the function and how they should be interpreted
 * @param fn The function to implement the builtin. It should use the VM from the parameter, and **not**
 * close over the one that is passed to the `vm` parameter of `defineBuiltin` (since this builtin may be reused for a sub-VM for
 * e.g. an FFI callback).
 * @returns the builtin function, for referring to later
 */
export const makeJSFun = <const T extends ShorthandArgument<any, any>[]>(name: string, signature: T, fn: JSFun<CallableSignatureFromShorthand<T>>["impl"], doc: string) => {
    return new JSFun(name, createSignature(signature), fn as any, doc);
}
/**
 * Defines the object in the VM's builtins scope as a constant.
 */
export const define = (vm: JebVM, name: string, obj: any) => {
    if (vm.builtinsEnv.get(name).ok) throw new Error(`Builtin ${stringify(name)} is already defined`);
    vm.builtinsEnv.addConst(name, obj);
}
/**
 * Creates a new opcode for the VM.
 * @param fn The function to implement the opcode.
 */
export const makeOpcode = <T extends OpcodeFunction<any>>(fn: T, doc: string | null): T => {
    (fn as T).doc = doc;
    return fn;
}
/**
 * Defines a new applier that can be used by the `jeb:apply` opcode to call something.
 *
 * @param describe Returns the metadata of the function, which includes the signature (see {@link CallableSignature})
 * @param run Should push opcodes to take the arguments object from the top of the stack and pass them to whatever the implementation is.
 * It should not actually call that implementation as the arguments object is not actually on the stack at the point this is called.
 */
export const defineApplier = <const T extends Type[], PO extends ProtocolObj<void, [T], {}, ApplyMetadata, ApplyFlags>>(vm: JebVM, type: T, run: PO["run"], describe: PO["describe"], doc: string) => {
    vm.addProtocol("apply", { type: [type], run, doc, describe });
}
/**
 * Defines a new evaluator that can be used by the `jeb:eval` opcode to evaluate or unwrap something.
 */

export const defineEvaluator = <const T extends Type[]>(vm: JebVM, type: T, fn: ProtocolObj<void, [T], {}, void, EvalFlags>["run"], doc: string) => {
    vm.addProtocol("eval", { type: [type], run: fn, doc });
}

/**
 * Defines a new accessor that can be used by the `jeb:get` and `jeb:set` opcodes to look up or reassign a field on something.
 */

export const defineAccessor = <const T extends Type[]>(vm: JebVM, type: T, fn: ProtocolObj<Reference, [T], {}, void, AccessFlags>["run"], doc: string) => {
    vm.addProtocol("access", { type: [type], run: fn, doc });
}

/**
 * Defines a new unwrapper to define how a special wrapper should be unwrapped.
 */

export const defineUnwrapper = <const T extends (typeof Wrapper)[]>(vm: JebVM, type: T, fn: ProtocolObj<void, [T], {}, void, void>["run"], doc: string) => {
    vm.addProtocol("unwrap", { type: [type], run: fn, doc });
}

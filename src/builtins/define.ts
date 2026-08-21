import { stringify } from "lib0/json";
import { BuiltinFunction, CallableSignatureFromShorthand, createSignature, ShorthandArgument } from "../callable";
import { AccessFlags, ApplyMetadata, ApplyOrEvalFlags, Reference, ProtocolObj, Type } from "../protocol";
import { JebVM, OpcodeFunction } from "../vm";
import { JEBOpcode } from "../opcodeTypes";
import { Wrapper } from "../wrapper";

/**
 * Special symbol that means "this function is a macro and pushed opcodes
 * which implement the return value, don't push my return value" for built-in functions,
 * which normally treat `undefined` as a valid return value and push it to the stack.
 */

export const NOTHING: unique symbol = Symbol("nothing");
/**
 * Defines a builtin function in the VM's builtins scope as a constant.
 * @param arity The allowable number of arguments to the function.
 * If an object, specifies the min and max.
 * If a number, min and max are the same.
 * If null, min = 0 and max = Infinity.
 * @param fn The function to implement the builtin. It should use the VM from the parameter, and **not**
 * close over the one that is passed to the `vm` parameter of `defineBuiltin` (since this builtin may be reused for a sub-VM for
 * e.g. an FFI callback).
 */

export const defineBuiltin = <const T extends ShorthandArgument<any, any>[]>(vm: JebVM, name: string, signature: T, fn: BuiltinFunction<CallableSignatureFromShorthand<T>>["impl"], doc: string) => {
    if (vm.builtinsEnv.get(name).ok) throw new Error(`Builtin ${stringify(name)} is already defined`);
    vm.builtinsEnv.addConst(name, new BuiltinFunction(name, createSignature(signature), fn as any, doc));
};
/**
 * Defines a new opcode for the VM.
 * @param fn The function to implement the opcode. It should use the VM from the parameter, and **not**
 * close over the one that is passed to the `vm` parameter of `defineOpcode` (since this opcode may be reused for a sub-VM for
 * e.g. an FFI callback).
 */
export const defineOpcode = <T extends keyof JEBOpcode>(vm: JebVM, name: T, fn: OpcodeFunction<T>, doc: string | null) => {
    if (vm.opcodes[name]) throw new Error(`Opcode ${stringify(name)} is already defined`);
    vm.opcodes[name] = [fn, doc] as any;
};
/**
 * Defines a new applier that can be used by the `jeb:apply` opcode to call something.
 *
 * @param describe Returns the metadata of the function, which includes the signature (see {@link CallableSignature})
 * @param run Should push opcodes to take the arguments object from the top of the stack and pass them to whatever the implementation is.
 * It should not actually call that implementation as the arguments object is not actually on the stack at the point this is called.
 */
// Why does this mess up the syntax highlighting ?!??!?!?!?

export const defineApplier = <const T extends Type[], PO extends ProtocolObj<void, [T], {}, ApplyMetadata, ApplyOrEvalFlags>>(vm: JebVM, type: T, run: PO["run"], describe: PO["describe"], doc: string) => {
    vm.addProtocol("apply", { type: [type], run, doc, describe });
};
/**
 * Defines a new applier that can be used by the `jeb:eval` opcode to evaluate or unwrap something.
 */

export const defineEvaluator = <const T extends Type[]>(vm: JebVM, type: T, fn: ProtocolObj<void, [T], {}, void, ApplyOrEvalFlags>["run"], doc: string) => {
    vm.addProtocol("eval", { type: [type], run: fn, doc });
};

/**
 * Defines a new accessor that can be used by the `jeb:get` and `jeb:set` opcodes to look up or reassign a field on something.
 */

export const defineAccessor = <const T extends Type[]>(vm: JebVM, type: T, fn: ProtocolObj<Reference, [T], {}, void, AccessFlags>["run"], doc: string) => {
    vm.addProtocol("access", { type: [type], run: fn, doc });
};

/**
 * Defines a new accessor that can be used by the `jeb:get` and `jeb:set` opcodes to look up or reassign a field on something.
 */

export const defineUnwrapper = <const T extends (typeof Wrapper)[]>(vm: JebVM, type: T, fn: ProtocolObj<void, [T], {}, void, void>["run"], doc: string) => {
    vm.addProtocol("unwrap", { type: [type], run: fn, doc });
};

/**
 * Copies the value of a builtin value to the new name in the builtins scope.
 * @param srcName Source (should already be defined)
 * @param dstName Target (will be defined to be the same as the source's value)
 */
export const alias = (vm: JebVM, srcName: string, dstName: string) => {
    const env = vm.builtinsEnv;
    if (env.get(dstName).ok) throw new Error(`Builtin ${stringify(dstName)} is already defined`);
    env.addConst(dstName, env.get(srcName).throw(`Alias source ${stringify(srcName)} doesn't exist`));
};

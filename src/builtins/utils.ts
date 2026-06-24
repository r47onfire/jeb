import { stringify } from "lib0/json";
import { BuiltinFunction } from "../callable";
import { Applier, Arity, JebVM, OpcodeFunction } from "../vm";

export const argsHelper = (vm: JebVM, args: any[], shouldEval: boolean) => {
    const len = args.length;
    for (var i = len - 1; i >= 0; i--) {
        vm.pushData(args[i]);
        if (shouldEval) {
            // rotate the argument we just evaluated around and bring up the next one
            // optimize if len == 1 then don't bother shuffling!
            if (len > 1) vm.pushCommand("jeb:shuffle", len, new Array(len).fill(0).map((_, j) => (j + 1) % len));
            vm.pushCommand("jeb:eval");
        }
    }
};

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
        if (!last) vm.pushCommand("jeb:shuffle", 1, []);
        vm.pushData(args[i]);
        // Do a tail call on the last item
        vm.pushCommand("jeb:eval", last);
    }
    return NOTHING;
};

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
export const defineBuiltin = <T extends JebVM>(vm: T, name: string, arity: Arity, isSpecial: boolean, resultIsMacro: boolean, fn: (args: any[], vm: T) => any, doc: string) => {
    vm.builtinsEnv.constant(name, new BuiltinFunction(name, arity, isSpecial, resultIsMacro, fn as any, doc));
};

/**
 * Defines a new opcode for the VM.
 * @param fn The function to implement the opcode. It should use the VM from the parameter, and **not**
 * close over the one that is passed to the `vm` parameter of `defineOpcode` (since this opcode may be reused for a sub-VM for
 * e.g. an FFI callback).
 */
export const defineOpcode = <T extends JebVM>(vm: T, name: string, fn: OpcodeFunction<T>) => {
    vm.opcodeTable[name] = fn;
};

/**
 * Defines a new applier that can be used by the `jeb:apply` opcode to call something.
 */
export const defineApplier = (vm: JebVM, apply: Applier<any>) => {
    vm.applyTable.push(apply);
};

/**
 * Copies the value of a builtin value to the new name in the builtins scope.
 * @param name1 Source (should already be defined)
 * @param name2 Target (will be defined to be the same as the source's value)
 */
export const alias = (vm: JebVM, name1: string, name2: string) => {
    const env = vm.builtinsEnv;
    env.constant(name2, env.get(name1).throw(`Alias source ${stringify(name1)} doesn't exist`));
};

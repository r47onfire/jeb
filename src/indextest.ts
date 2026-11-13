/**
 * The test-side half of JEB: a ready-made VM over JSON code, plus run helpers.
 * The core (`index`) ships the JSON evaluator and the builtins; this module
 * adds a reference call dispatch, and is exported as the package's
 * `./indextest` entry so layers built on JEB (e.g. Kuiper) can test against a
 * working VM without re-implementing one.
 */
import { JSFun, makeJSFun, type HostFunction } from "./callable";
import { Closure } from "./closure";
import { Continuation } from "./continuation";
import {
    compressStackTree,
    formatStackTraceCompact,
    JEBError,
    promisifyVM,
    wrapThrowToError,
} from "./errors";
import { JSONCode, JSONValue } from "./evaluate";
import { CallArgs, evalCallArgs, OP_call_return, seqStart } from "./opcodes";
import { bindArgs } from "./signature";
import { Identifier } from "./utils";
import { JebVM, pushCommand, pushData, SCHEDULED, StackEntryKind } from "./vm";

export { JSFun, makeJSFun };
export type { HostFunction };

/** The test layer's no-value sentinel: what {@link TestVM.noValue} returns. */
export const NO_VALUE = Symbol("NO_VALUE");

/**
 * A working VM over JS values and JSON code, implementing every hook the core
 * leaves abstract in the simplest reasonable way: None is `null`, numbers are
 * themselves (through the `wrapNumber` hook), the no-value sentinel is
 * {@link NO_VALUE}, errors are {@link JEBError}s with the traceback attached at
 * creation, truthiness is the host's, and variables live in the core's
 * environments (the builtins environment is the root environment's parent, so
 * builtins are simply in scope).
 *
 * The dispatch knows three callable shapes: continuations (which take the value
 * they are invoked with), closures, and {@link JSFun}s. Closures and JSFuns
 * share the signature-binding step (`bindArgs`): arguments are evaluated unless
 * their parameter is lazy, counts are checked, defaults are filled in, and rest
 * arguments are bundled. Anything else is not callable. Every closure call gets
 * a `return` continuation injected into its scope.
 */
export class TestVM extends JebVM<any, any> {
    // The value and error hooks.
    override noneValue() {
        return null;
    }
    override noValue() {
        return NO_VALUE;
    }
    override createError(message: string) {
        const array = this.tracebackArray();
        return new JEBError(
            message +
                " (" +
                formatStackTraceCompact(compressStackTree(array)) +
                ")",
            {},
            {},
            array,
        );
    }
    override isError(value: unknown) {
        return value instanceof JEBError;
    }
    // The conversion hooks: this layer's values are JS values, so
    // boolification is the identity and truthiness is the host's.
    override boolify(value: any) {
        pushData(this, value);
    }
    override isTruthy(value: any) {
        return !!value;
    }
    override booleanValue(value: boolean) {
        return value;
    }
    override wrapNumber(value: number): any {
        return value;
    }
    // The variable hooks: plain environment access. The builtins
    // environment is the root scope's parent, so it is searched too.
    override getVariable(name: Identifier) {
        const result = this.currentEnv.get(name);
        if (result.ok) return result.data;
        throw this.createError(`no such variable: ${String(name)}`);
    }
    override defineVariable(name: Identifier, value: any, constant: boolean) {
        if (constant) this.currentEnv.addConst(name, value);
        else this.currentEnv.add(name, value);
    }
    override assignVariable(name: Identifier, value: any) {
        const scope = this.currentEnv.set(name, value);
        if (scope === undefined)
            throw this.createError(
                `cannot assign to undefined variable: ${String(name)}`,
            );
        if (scope === false)
            throw this.createError(`cannot assign to constant: ${String(name)}`);
    }
    /**
     * Registers a host function in the builtins environment, through the same
     * {@link JSFun} wrapper the builtins themselves use: `params` is a parameter
     * list form (see `parseSignature`).
     */
    defineHostFunction(name: Identifier, params: JSONCode, fn: HostFunction) {
        if (this.builtinsEnv.scopeFor(name).ok)
            throw new Error(
                `host function ${String(name)} is already registered`,
            );
        this.builtinsEnv.add(name, makeJSFun(this, name, params, fn));
    }
    /** Registers a host value in the builtins environment. */
    defineValue(name: Identifier, value: any) {
        if (this.builtinsEnv.scopeFor(name).ok)
            throw new Error(`host value ${String(name)} is already registered`);
        this.builtinsEnv.add(name, value);
    }
    override dispatchCall(call: CallArgs<any, any>) {
        const { callee } = call;
        if (callee instanceof Continuation) {
            // a continuation takes at most one argument: the value it
            // resumes with (extra arguments are evaluated and ignored)
            evalCallArgs(this, call, (_vm, values) =>
                callee.invoke(this, values[0]),
            );
            return;
        }
        if (callee instanceof Closure) {
            bindArgs(this, call, callee.signature, (values) =>
                this.invokeClosure(call, values),
            );
            return;
        }
        if (callee instanceof JSFun) {
            bindArgs(this, call, callee.signature, (values) =>
                this.invokeJSFun(call, values),
            );
            return;
        }
        throw this.createError(`value is not callable: ${typeof callee}`);
    }
    /** Calls a closure with its bound argument values. */
    private invokeClosure(
        { callee, tail, source, name }: CallArgs<any, any>,
        values: any[],
    ) {
        const closure = callee as Closure<any>;
        const { params, rest } = closure.signature;
        const env = this.createEnv(closure.env);
        params.forEach((param, i) => env.add(param.name, values[i]));
        if (rest !== undefined) env.add(rest.name, values[params.length]);
        // `return` is injected as a continuation that abandons the body
        // and makes the call produce the value it is given. It is
        // captured before the call's own frame machinery is scheduled,
        // so invoking it restores the caller's state exactly.
        env.add("return" as Identifier, this.cc());
        const frameName = name ?? closure.name;
        if (frameName !== undefined)
            this.pushTraceback(
                frameName,
                tail,
                source,
                StackEntryKind.FUNCTION,
            );
        pushCommand(
            this,
            OP_call_return,
            this.currentEnv,
            !tail && frameName !== undefined,
        );
        this.currentEnv = env;
        seqStart(this, [...closure.body], true);
    }
    /** Calls a host function with its bound argument values. */
    private invokeJSFun(
        { callee, tail, source, name, frame }: CallArgs<any, any>,
        values: any[],
    ) {
        const fun = callee as JSFun<any>;
        const frameName = name ?? fun.name;
        if (frameName !== undefined)
            this.pushTraceback(
                frameName,
                tail,
                source,
                StackEntryKind.FUNCTION,
            );
        const result = wrapThrowToError(this, () => fun.fn(this, ...values));
        if (result === SCHEDULED) {
            // The function arranged the call's result itself, by
            // scheduling commands: the call is transparent, so its
            // traceback entry and call frame are dropped now (the frame
            // pop scheduled by OP_call_invoke then finds a different
            // frame on top and does nothing). Code the function
            // scheduled therefore sees the caller's frame, not this one.
            if (frameName !== undefined) this.popTraceback(false);
            if (frame !== undefined && this.callFrames?.value === frame)
                this.callFrames = this.callFrames?.next ?? null;
            return;
        }
        if (result instanceof Promise) {
            // The frame stays up while the VM is paused on the promise,
            // and is dropped when it resolves (on rejection it stays, so
            // the error's traceback includes this call).
            promisifyVM(
                this,
                result.then((value) => {
                    if (frameName !== undefined) this.popTraceback(false);
                    return value;
                }),
            );
            return;
        }
        // A synchronous host call is a leaf: no frames were pushed above
        // this one, so it can always be dropped directly. On a throw the
        // frame is left in place for the error's traceback.
        if (frameName !== undefined) this.popTraceback(false);
        pushData(this, result);
    }
}

// MARK: run helpers

/**
 * Drives a VM to completion synchronously and returns its result (the top of
 * the data stack). The error that stopped the VM, if any, is thrown.
 */
export const run = (vm: JebVM<any, any>, code: JSONCode) => {
    vm.start(code);
    while (!vm.done && !vm.error) vm.step();
    if (vm.error) throw vm.error;
    return vm.popData();
};

/** Like {@link run}, but awaits the VM whenever it pauses on a promise. */
export const runAsync = async (vm: JebVM<any, any>, code: JSONCode) => {
    vm.start(code);
    while (!vm.done && !vm.error) {
        if (vm.paused) await vm.awaiting;
        else vm.step();
    }
    if (vm.error) throw vm.error;
    return vm.popData();
};

/**
 * Builds a test-registration helper (the `testTest` wrapper) bound to a VM
 * factory: each registered test gets a fresh VM and its captured output, and a
 * VM error is printed with its traceback before the test fails. `testfun` is
 * the test framework's own registration function (e.g. `test` from `bun:test`),
 * passed in so this module stays framework-free.
 */
export const makeTestRun =
    <V extends JebVM<any, any>>(createVM: () => { vm: V; out: string[] }) =>
    <U>(
        testfun: (name: string, body: () => U) => void,
        name: string,
        testBody: (vm: V, out: string[]) => U,
    ) => {
        const { vm, out } = createVM();
        testfun(name, () => {
            try {
                return testBody(vm, out);
            } catch (e) {
                if (vm.isError(e)) {
                    console.error("VM Error Caught!");
                    console.error(String(e));
                }
                throw e;
            }
        });
    };

export type { JSONValue };

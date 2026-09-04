import { isinstance, LinkedList, LinkedList_length, LinkedList_pop, LinkedList_popN, LinkedList_push } from "@r47onfire/game-math";
import { isArray } from "lib0/array";
import { min } from "lib0/math";
import { JEBAuditEvents } from "./auditHookTypes";
import { loadBuiltins, OP_eval, OP_throw } from "./builtins";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { createStackInnerNode, createStackLeafNode, JEBError, JEBRecursionError, JEBTypeError, Location, locationsEqual, StackTreeNode } from "./errors";
import { __initializer, __initializers } from "./initializers";
import { ArgcForName, getProtocolHandler, JEBProtocols, theTypeName, typeOf } from "./protocol";
import { OP_unwrap } from "./unwrap";
import { Identifier, Tuple } from "./utils";
export { __initializer };

/**
 * Data for the command
 */
export type Command<T extends JebVM> = [opcode: OpcodeFunction<any, T>, ...immediateArgs: any[]];
export interface StackCount {
    readonly name: Identifier | undefined;
    readonly location: Location | undefined;
    readonly count: number;
    readonly tail: boolean;
}

/**
 * Function that implements an opcode for the VM by pushing instructions or pushing and popping data.
 */
export type OpcodeFunction<T extends any[], U extends JebVM> = ((vm: U, ...args: T) => void);

export type GetArgParams<T extends OpcodeFunction<any, any>> = Parameters<T>[1] extends infer T extends any[] ? T : [void];

/**
 * Base VM for running JEB code
 */
export class JebVM<T extends JebVM = any> {
    /** current environment */
    currentEnv!: Env;
    /** stack of commands to execute */
    commandStack!: LinkedList<Command<T>>;
    /** stack of values */
    dataStack!: LinkedList<any>;
    /** current dynamic wind stack (linked list / tree) */
    curDynamicWind!: DynamicWind<T>;
    /** whether the VM is paused */
    paused!: boolean;
    /** the Promise that the VM is currently waiting on */
    awaiting: Promise<void> | null = null;
    /** callstack entries */
    tracebackStack!: LinkedList<StackCount>;
    /** Environment that all builtins live in */
    builtinsEnv = this.createEnv();
    protocols: Partial<JEBProtocols> = {};
    getState(): any { }
    restoreState(state: any): void { }

    constructor() {
        this.reset();
        loadBuiltins(this as any as T);
        __initializers.forEach(f => f(this as any as T));
    }
    addProtocol<N extends keyof JEBProtocols>(name: N, impl: JEBProtocols[N][number]) {
        (this.protocols[name] ??= [] as any[]).push(impl);
    }
    getProtocol<N extends keyof JEBProtocols, T extends boolean>(fast: boolean, assert: T, name: N, args: Tuple<any, ArgcForName<N>>): JEBProtocols[N][number] | (T extends true ? never : undefined) {
        const res = getProtocolHandler(this.protocols, fast, name, args);
        if (assert && !res) throw new JEBTypeError(`No overload of ${String(name)} exists for type${args.length > 1 ? "s" : ""} ${args.map(x => theTypeName(typeOf(x))).join(", ")}`);
        return res!;
    }
    pushData(value: any) {
        this.dataStack = LinkedList_push(this.dataStack, value);
    }
    #checkStack(n: number) {
        if (LinkedList_length(this.dataStack) < n) throw new JEBError("data stack underflow");
    }
    popNData(n: number) {
        this.#checkStack(n);
        const { 0: values, 1: rest } = LinkedList_popN(this.dataStack!, n);
        this.dataStack = rest;
        return values.reverse();
    }
    popData() {
        this.#checkStack(1);
        const { 0: value, 1: rest } = LinkedList_pop(this.dataStack!);
        this.dataStack = rest;
        return value;
    }
    peekData() {
        this.#checkStack(1);
        return this.dataStack!.value;
    }
    pushCommand<TOpcode extends OpcodeFunction<any, T>>(f: TOpcode, ...args: GetArgParams<TOpcode>) {
        this.commandStack = LinkedList_push(this.commandStack, [f, ...args]);
    }
    popCommand() {
        if (LinkedList_length(this.commandStack) === 0) throw new JEBError("opcode stack underflow");
        const { 0: value, 1: rest } = LinkedList_pop(this.commandStack!);
        this.commandStack = rest;
        return value;
    }
    get done() {
        return LinkedList_length(this.commandStack) === 0;
    }
    /**
     * Runs one opcode.
     * @returns true if progress was made, false if there's nothing left to do
     * @example
     * ```ts
     * while (vm.step()); // Steps as far as possible until there's nothing left to do
     * ```
     */
    step() {
        if (this.paused || this.done) return false;
        const command = this.popCommand();
        try {
            command[0](this as any as T, command.slice(1));
        } catch (e) {
            if (isArray(e) && e.length === 3 && isinstance(e[1], JEBError)) throw e[1];
            if (!isinstance(e, JEBError)) throw e;
            e.traceback ??= this.tracebackArray();
            this.pushCommand(OP_throw, e);
        }
        return true;
    }

    /**
     * Starts running the code
     * @param code Code to run
     * @throws if the VM is already running (i.e. there are commands on the command stack)
     */
    start(code: any) {
        if (LinkedList_length(this.commandStack) > 0) throw new Error("VM is already running");
        pushData(this as any as T, code);
        pushCommand(this as any as T, OP_unwrap, []);
        pushCommand(this as any as T, OP_eval, undefined);
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to the initial empty state.
     * Does not clear the builtins env.
     */
    reset() {
        this.paused = false;
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.currentEnv = this.createEnv(this.builtinsEnv);
        this.curDynamicWind = new DynamicWind(this as any as T);
    }
    /**
     * Gets the length of the command stack.
     */
    get recursionDepth() {
        return LinkedList_length(this.commandStack);
    }
    /**
     * If the {@link recursionDepth} is larger than the given length, adds an error to the command stack
     * to signal to the running program that it's recursing too much
     * @param length Maximum length before an error is added
     */
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand(OP_throw, new JEBRecursionError("too much recursion", {}, this.tracebackArray()));
        }
    }
    /**
     * Returns the names of the functions in the call stack, with innermost first
     * @returns list of stack entries, with only 1-element repeats compressed.
     */
    tracebackArray(numToDrop = 0) {
        var stack = this.tracebackStack;
        const parts: StackTreeNode[] = [];
        var prev: StackCount | undefined, prevCount = 0;
        const flush = () => {
            if (prevCount > 0) {
                const leaf = createStackLeafNode(prev!.name, prev!.location);
                parts.push(prevCount > 1 ? createStackInnerNode(prevCount, [leaf]) : leaf);
            }
            prevCount = 0;
        };
        while (stack) {
            const { name, location, count } = stack.value;
            if (prev && (prev.name !== name || prev.location !== location)) flush();
            const off = min(count, numToDrop);
            prevCount += count - off;
            numToDrop -= off;
            prev = stack.value;
            stack = stack.next;
        }
        flush();
        return parts;
    }
    /**
     * Adds a function call entry to the traceback stack
     * @param func Name of the function that is now being called
     * @param tailcallHint True if the function was tail-called
     */
    pushTraceback(func: Identifier | undefined, tailcallHint: boolean, callsiteLocation: Location | undefined) {
        const top = this.tracebackStack;
        if (top) {
            const { value: { name, tail, location, count }, next } = top;
            if (name === func && tail === tailcallHint && locationsEqual(location, callsiteLocation)) {
                // same name and type = just bump the counter
                this.tracebackStack = LinkedList_push(next, { name: func, count: count + 1, tail: tailcallHint, location: callsiteLocation });
                return;
            }
        }
        this.tracebackStack = LinkedList_push(top, { name: func, count: 1, tail: tailcallHint, location: callsiteLocation });
    }
    /**
     * Drops all the tail-call entries off the stack, and then one more
     */
    popTraceback(dropTail = true) {
        var cur = this.tracebackStack;
        if (!cur) throw new JEBError("traceback stack underflow");

        // drop all TCO'ed frames
        if (dropTail) while (cur && cur.value.tail) {
            cur = cur.next;
        }

        if (!cur) {
            // oops, all tail calls
            this.tracebackStack = null;
            return;
        }

        // normal frame pop
        if (cur.value.count > 1) {
            this.tracebackStack = LinkedList_push(cur.next, { ...cur.value, count: cur.value.count - 1 });
        } else {
            this.tracebackStack = cur.next;
        }
    }
    newDynamicWind() {
        return new DynamicWind(this as any as T);
    }
    createEnv(...parents: Env[]) {
        return new Env({}, parents);
    }
    getCurrentFile(): string | undefined {
        return undefined;
    }
    /**
     * Returns the current continuation at this state.
     * @param extraOps Extra opcodes to push to the command stack *when this continuation is invoked* (not now).
     */
    cc(...extraOps: Command<T>[]) {
        return new Continuation(this as any as T, extraOps);
    }
    fatalError(error: JEBError): never {
        throw [, error, ,];
    }

    #auditHooks = new Set<<T extends keyof JEBAuditEvents>(event: T, ...args: JEBAuditEvents[T]) => void>();
    /**
     * Adds an audit hook that will be called every time something that should be audited happens.
     * @returns callback to cancel the audit hook
     */
    addAuditHook(cb: <T extends keyof JEBAuditEvents>(event: T, ...args: JEBAuditEvents[T]) => void): () => void {
        this.audit("jeb:add_audit_hook");
        this.#auditHooks.add(cb);
        return () => this.#auditHooks.delete(cb);
    }
    /**
     * Raises an auditing event
     */
    audit<T extends keyof JEBAuditEvents>(...args: [event: T, ...JEBAuditEvents[T]]) {
        this.#auditHooks.forEach(hook => hook(...args));
    }
}

export const pushData = <T extends JebVM>(vm: T, data: any) => vm.pushData(data);
export const pushCommand = <T extends OpcodeFunction<any, U>, U extends JebVM>(vm: U, cmd: T, ...args: GetArgParams<T>) => vm.pushCommand(cmd, ...args);
export const popData = <T extends JebVM>(vm: T) => vm.popData();
export const popNData = <T extends JebVM>(vm: T, n: number) => vm.popNData(n);
export const peekData = <T extends JebVM>(vm: T) => vm.peekData();

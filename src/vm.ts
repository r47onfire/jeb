import { isinstance, LinkedList, LinkedList_length, LinkedList_pop, LinkedList_popN, LinkedList_push } from "@r47onfire/game-math";
import { isArray } from "lib0/array";
import { min } from "lib0/math";
import { JEBAuditEvent } from "./auditHookTypes";
import { loadBuiltins } from "./builtins";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { createStackInnerNode, createStackLeafNode, JEBError, JEBRecursionError, JEBTypeError, StackTreeNode } from "./errors";
import { JEBOpcode } from "./opcodeTypes";
import { ArgcForName, getProtocolHandler, JEBProtocols, theTypeName, typeOf } from "./protocol";
import { Identifier, Tuple } from "./utils";
import { Wrapper } from "./wrapper";

/**
 * Data for the command
 */
export type Command = [opcode: keyof JEBOpcode, ...immediateArgs: any[]];
export interface StackCount {
    readonly name: Identifier;
    readonly location: string | undefined;
    readonly count: number;
    readonly tail: boolean;
}

/**
 * Function that implements an opcode for the VM by pushing instructions or pushing and popping data.
 */
export type OpcodeFunction<T extends keyof JEBOpcode> = (vm: JebVM, args: JEBOpcode[T]) => void;

/**
 * Base VM for running JEB code
 */
export class JebVM {
    /** current environment */
    currentEnv!: Env;
    /** stack of commands to execute */
    commandStack!: LinkedList<Command>;
    /** stack of values */
    dataStack!: LinkedList<any>;
    /** current dynamic wind stack (linked list / tree) */
    curDynamicWind!: DynamicWind;
    /** whether the VM is paused */
    paused!: boolean;
    /** callstack entries */
    tracebackStack!: LinkedList<StackCount>;
    /** Environment that all builtins live in */
    builtinsEnv = this.createEnv();
    opcodes: Partial<{ [K in keyof JEBOpcode]: [impl: OpcodeFunction<K>, doc: string | null] }> = {};
    protocols: Partial<JEBProtocols> = {};
    copyableState: Exclude<keyof this, keyof JebVM>[] = [];

    constructor() {
        this.reset();
        loadBuiltins(this);
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
    pushCommand<T extends keyof JEBOpcode>(name: T, ...args: JEBOpcode[T]) {
        this.commandStack = LinkedList_push(this.commandStack, [name, ...args]);
    }
    popCommand() {
        if (LinkedList_length(this.commandStack) === 0) throw new JEBError("opcode stack underflow");
        const { 0: value, 1: rest } = LinkedList_pop(this.commandStack!);
        this.commandStack = rest;
        return value;
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
        if (this.paused) return false;
        if (LinkedList_length(this.commandStack) === 0) return false;
        const command = this.popCommand();
        const opcode = this.opcodes[command[0]];
        if (!opcode) throw new JEBError(`Unknown opcode: ${command[0]}`);
        try {
            opcode[0](this, command.slice(1));
        } catch (e) {
            if (isArray(e) && e.length === 3 && isinstance(e[1], JEBError)) throw e[1];
            if (!isinstance(e, JEBError)) throw e;
            e.traceback ??= this.tracebackArray();
            this.pushCommand("jeb:throw", e);
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
        this.pushData(code);
        this.pushCommand("jeb:unwrap", []);
        this.pushCommand("jeb:eval");
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to the initial empty state.
     * Does not clear the global or builtins env.
     */
    reset() {
        this.paused = false;
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.currentEnv = this.createEnv(this.builtinsEnv);
        this.curDynamicWind = new DynamicWind(this);
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
            this.pushCommand("jeb:throw", new JEBRecursionError("too much recursion", {}, this.tracebackArray()));
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
    pushTraceback(func: Identifier, tailcallHint: boolean, callsiteLocation: string | undefined) {
        const top = this.tracebackStack;
        if (top) {
            const { value: { name, tail, location, count }, next } = top;
            if (name === func && tail === tailcallHint && location === callsiteLocation) {
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
        return new DynamicWind(this);
    }
    createEnv(...parents: Env[]) {
        return new Env({}, parents);
    }
    /**
     * Returns the current continuation at this state.
     * @param extraOps Extra opcodes to push to the command stack *when this continuation is invoked* (not now).
     */
    cc(...extraOps: Command[]) {
        return new Continuation(this, extraOps);
    }
    fatalError(error: JEBError): never {
        throw [, error, ,];
    }

    #auditHooks = new Set<<T extends keyof JEBAuditEvent>(event: T, ...args: JEBAuditEvent[T]) => void>();
    /**
     * Adds an audit hook that will be called every time something that should be audited happens.
     * @returns callback to cancel the audit hook
     */
    addAuditHook(cb: <T extends keyof JEBAuditEvent>(event: T, ...args: JEBAuditEvent[T]) => void): () => void {
        this.audit("jeb:add_audit_hook");
        this.#auditHooks.add(cb);
        return () => this.#auditHooks.delete(cb);
    }
    /**
     * Raises an auditing event
     */
    audit<T extends keyof JEBAuditEvent>(...args: [event: T, ...JEBAuditEvent[T]]) {
        this.#auditHooks.forEach(hook => hook(...args));
    }
}

export const pushData = (vm: JebVM, data: any) => vm.pushData(data);
export const pushCommand: {
    <T extends new (obj: any, ...args: A) => Wrapper, A extends any[]>(vm: JebVM, name: "jeb:wrap", cls: T, ...extraArgs: A): void;
    <T extends keyof JEBAuditEvent>(vm: JebVM, name: "jeb:audit", event: T, ...args: JEBAuditEvent[T]): void;
    <T extends keyof JEBOpcode>(vm: JebVM, name: T, ...args: JEBOpcode[T]): void;
} = (vm: JebVM, cmd: keyof JEBOpcode, ...args: unknown[]) => vm.pushCommand(cmd, ...args);
export const popData = (vm: JebVM) => vm.popData();
export const popNData = (vm: JebVM, n: number) => vm.popNData(n);
export const peekData = (vm: JebVM) => vm.peekData();

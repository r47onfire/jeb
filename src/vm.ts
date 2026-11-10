import {
    EventDispatcher,
    LinkedList,
    LinkedList_length,
    LinkedList_pop,
    LinkedList_popN,
    LinkedList_push,
} from "@r47onfire/game-math";
import { min } from "lib0/math";
import { JEBAuditEvents } from "./auditHookTypes";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import {
    createStackInnerNode,
    createStackLeafNode,
    JEBError,
    StackTreeNode,
} from "./errors";
import { SourceInfo, sourcesEqual } from "./ir";
import {
    CallArgs,
    loadCoreOpcodes,
    OP_call_invoke,
    OP_eval,
    OP_throw,
    OpcodeHandler,
} from "./opcodes";
import { Identifier } from "./utils";

/** Data for the command */
export type Command<T extends JebVM<D, S, T>, D, S, A extends any[] = any[]> = [
    opcode: OpcodeFunction<A, T, D, S>,
    ...immediateArgs: A,
];

export enum StackEntryKind {
    FUNCTION,
    MACRO_EXPANSION_RESULT,
    PARAMETER,
    NONE,
}

export interface StackEntry<S> {
    /** Name of the function called, if known */
    readonly name: Identifier | undefined;
    /** Source of the call site, if known */
    readonly source: SourceInfo<S> | undefined;
    readonly kind: StackEntryKind;
}

/**
 * One compressed run of call-stack frames: `count` consecutive calls of the
 * same function at the same call site, collapsed into a single traceback
 * entry.
 */
export interface StackCount<S> {
    readonly item: StackEntry<S>;
    /** Number of frames collapsed into this entry */
    readonly count: number;
    /** Whether these frames were entered by tail calls */
    readonly tail: boolean;
}

/**
 * Function that implements an opcode for the VM by pushing instructions or
 * pushing and popping data.
 */
export type OpcodeFunction<T extends any[], U extends JebVM<D, S>, D, S> = (
    vm: U,
    ...args: T
) => void;

/**
 * Extracts the type of an opcode function's immediate arguments (everything
 * after the VM parameter), for typing calls to {@link JebVM.pushCommand}.
 */
export type GetArgParams<T extends OpcodeFunction<any, any, any, any>> =
    Parameters<T>[1] extends infer T extends any[] ? T : [void];

/** Base VM for running JEB code */
export abstract class JebVM<
    D,
    S,
> extends EventDispatcher<JEBAuditEvents> {
    /** Current environment */
    currentEnv!: Env<D>;
    /** Stack of commands to execute */
    commandStack!: LinkedList<Command<this, D, S>>;
    /** Stack of values */
    dataStack!: LinkedList<D>;
    /** Current dynamic wind stack (linked list / tree) */
    curDynamicWind!: DynamicWind<this, D, S>;
    /** Whether the VM is paused */
    paused!: boolean;
    /** The Promise that the VM is currently waiting on */
    awaiting: Promise<void> | null = null;
    /** Callstack entries */
    tracebackStack!: LinkedList<StackCount<S>>;
    /**
     * The opcode table: maps an IR node's opcode name to the handler that
     * evaluates it. The core opcodes are installed by the constructor; hosts
     * and higher layers (e.g. Kuiper) register more with {@link defineOpcode}.
     */
    opcodes: Record<string, OpcodeHandler<D, S>> = {};
    /**
     * Sources of the macro expansions the evaluator is currently inside,
     * outermost first. A node's own source link (`expandedFrom`) is pushed here
     * while its subtree runs, so nested code can see the full expansion context
     * it was generated in.
     */
    expansionStack: SourceInfo<any>[] = [];
    /** The error that stopped the VM, if any; {@link step} rethrows it while set */
    error: JEBError<this, D, S> | undefined;
    /**
     * Hook for VM subclasses with extra state beyond the base stacks: returns a
     * snapshot of that state, so continuations and dynamic-wind can save and
     * restore it. The base VM has no extra state.
     */
    getState(): any {}
    /** Counterpart to {@link getState}: restores a snapshot it returned earlier. */
    restoreState(state: any): void {}

    constructor() {
        super();
        this.reset();
        loadCoreOpcodes(this);
    }
    /**
     * Registers an opcode handler under the given name. Throws if the name is
     * already taken: there is only ever one handler per opcode.
     */
    defineOpcode(name: string, handler: OpcodeHandler<D, S>) {
        if (Reflect.has(this.opcodes, name))
            throw new Error(`opcode ${name} is already defined`);
        this.opcodes[name] = handler;
    }
    /**
     * The one calling-dispatch point: given a callee and its already-evaluated
     * arguments, make the call happen, leaving exactly one result on the data
     * stack (or scheduling the commands that do).
     *
     * The core runtime deliberately does not know how to call anything: which
     * values are callable, and what calling them does, is determined entirely
     * by the layer above. A subclass must implement this method to provide real
     * calling. Everything in the core that needs to call a value (the `call`
     * opcode, `callcc`, `dynamic-wind`, the dynamic-wind handler calls made by
     * continuations and by error unwinding) routes through the
     * {@link OP_call_invoke} command, which delegates here.
     */
    abstract dispatchCall(call: CallArgs<D, S>): void;

    /** Pushes a value onto the data stack. */
    pushData(value: any) {
        this.dataStack = LinkedList_push(this.dataStack, value);
        // console.log("push data", value);
    }
    /** Throws if the data stack holds fewer than `n` values. */
    #checkStack(n: number) {
        if (LinkedList_length(this.dataStack) < n)
            throw new JEBError("data stack underflow");
    }
    /**
     * Pops the top `n` values off the data stack, returned in the order they
     * were pushed (deepest first).
     */
    popNData(n: number) {
        this.#checkStack(n);
        const { 0: values, 1: rest } = LinkedList_popN(this.dataStack!, n);
        this.dataStack = rest;
        // console.log("pop N data", values);
        return values.reverse();
    }
    /** Pops and returns the top value of the data stack. */
    popData() {
        this.#checkStack(1);
        const { 0: value, 1: rest } = LinkedList_pop(this.dataStack!);
        this.dataStack = rest;
        // console.log("pop data", value);
        return value;
    }
    /** Returns the top value of the data stack without removing it. */
    peekData() {
        this.#checkStack(1);
        return this.dataStack!.value;
    }
    /**
     * Pushes a command (an opcode function plus its immediate arguments) onto
     * the command stack, to be run by a later {@link step}.
     */
    pushCommand<TOpcode extends OpcodeFunction<any, this, D, S>>(
        f: TOpcode,
        ...args: GetArgParams<TOpcode>
    ) {
        this.commandStack = LinkedList_push(this.commandStack, [f, ...args]);
    }
    /**
     * Pops and returns the next command to run. Throws if the command stack is
     * empty.
     */
    popCommand() {
        if (LinkedList_length(this.commandStack) === 0)
            throw new JEBError("opcode stack underflow");
        const { 0: value, 1: rest } = LinkedList_pop(this.commandStack!);
        this.commandStack = rest;
        return value;
    }
    /** Whether the VM has run out of commands to execute. */
    get done() {
        return LinkedList_length(this.commandStack) === 0;
    }
    /**
     * Runs one opcode.
     *
     * @example
     *     ```ts
     *     while (vm.step()); // Steps as far as possible until there's nothing left to do
     *     ```;
     *
     * @returns True if progress was made, false if there's nothing left to do
     */
    step() {
        if (this.paused || this.done) return false;
        if (this.error) throw this.error;
        const command = this.popCommand();
        try {
            command[0](this, command.slice(1));
        } catch (e) {
            if (!(e instanceof JEBError)) throw e;
            e.traceback ??= this.tracebackArray();
            this.pushCommand(OP_throw, e);
        }
        return true;
    }

    /**
     * Starts running the code
     *
     * @param code Code to run
     * @throws If the VM is already running (i.e. there are commands on the
     *   command stack)
     */
    start(code: any) {
        if (LinkedList_length(this.commandStack) > 0)
            throw new Error("VM is already running");
        pushCommand(this as any as T, OP_eval, code, true);
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to
     * the initial empty state. Does not clear the opcode table or the host
     * registry.
     */
    reset() {
        this.paused = false;
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.expansionStack = [];
        this.currentEnv = this.createEnv();
        this.curDynamicWind = new DynamicWind(this as any as T);
        this.error = undefined;
    }
    /** Gets the length of the command stack. */
    get recursionDepth() {
        return LinkedList_length(this.commandStack);
    }
    /**
     * If the {@link recursionDepth} is larger than the given length, adds an
     * error to the command stack to signal to the running program that it's
     * recursing too much
     *
     * @param length Maximum length before an error is added
     */
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand(
                OP_throw,
                new JEBError(
                    "too much recursion",
                    {},
                    {},
                    this.tracebackArray(),
                ),
            );
        }
    }
    /**
     * Returns the names of the functions in the call stack, with innermost
     * first
     *
     * @returns List of stack entries, with only 1-element repeats compressed.
     */
    tracebackArray(numToDrop = 0) {
        var stack = this.tracebackStack;
        const parts: StackTreeNode[] = [];
        var prev: StackCount<S> | undefined,
            prevCount = 0;
        const flush = () => {
            if (prevCount > 0) {
                const leaf = createStackLeafNode(
                    prev!.item.name,
                    prev!.item.source,
                    prev!.item.kind,
                );
                parts.push(
                    prevCount > 1
                        ? createStackInnerNode(prevCount, [leaf])
                        : leaf,
                );
            }
            prevCount = 0;
        };
        while (stack) {
            const {
                item: { name, source },
                count,
            } = stack.value;
            if (
                prev &&
                (prev.item.name !== name ||
                    !sourcesEqual(prev.item.source, source))
            )
                flush();
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
     *
     * @param func Name of the function that is now being called
     * @param tailcallHint True if the function was tail-called
     */
    pushTraceback(
        func: Identifier | undefined,
        tailcallHint: boolean,
        callsiteSource: SourceInfo<any> | undefined,
        entryKind: StackEntryKind,
    ) {
        const top = this.tracebackStack;
        if (top) {
            const {
                value: {
                    item: { name, source, kind },
                    tail,
                    count,
                },
                next,
            } = top;
            if (
                name === func &&
                tail === tailcallHint &&
                kind === entryKind &&
                sourcesEqual(source, callsiteSource)
            ) {
                // same name and type = just bump the counter
                this.tracebackStack = LinkedList_push(next, {
                    item: {
                        name: func,
                        source: callsiteSource,
                        kind: entryKind,
                    },
                    count: count + 1,
                    tail: tailcallHint,
                });
                return;
            }
        }
        this.tracebackStack = LinkedList_push(top, {
            item: { name: func, source: callsiteSource, kind: entryKind },
            count: 1,
            tail: tailcallHint,
        });
    }
    /** Drops all the tail-call entries off the stack, and then one more */
    popTraceback(dropTail = true) {
        var cur = this.tracebackStack;
        if (!cur) throw new JEBError("traceback stack underflow");

        // drop all TCO'ed frames
        if (dropTail)
            while (cur && cur.value.tail) {
                cur = cur.next;
            }

        if (!cur) {
            // oops, all tail calls
            this.tracebackStack = null;
            return;
        }

        // normal frame pop
        if (cur.value.count > 1) {
            this.tracebackStack = LinkedList_push(cur.next, {
                ...cur.value,
                count: cur.value.count - 1,
            });
        } else {
            this.tracebackStack = cur.next;
        }
    }
    /** Creates a fresh dynamic-wind node whose parent is the VM's current node. */
    newDynamicWind() {
        return new DynamicWind(this);
    }
    /** Creates a new environment inheriting from the given parent environments. */
    createEnv(...parents: Env<D>[]) {
        return new Env({}, parents);
    }
    /**
     * Returns the current continuation at this state.
     *
     * @param extraOps Extra opcodes to push to the command stack _when this
     *   continuation is invoked_ (not now).
     */
    cc(...extraOps: Command<T, D, S>[]) {
        return new Continuation(this as any as T, extraOps);
    }
}

/**
 * Standalone form of {@link JebVM.pushData}, for opcodes (which receive the VM
 * and their arguments separately rather than as a method receiver).
 */
export const pushData = <T extends JebVM<D, S>, D, S>(vm: T, data: any) =>
    vm.pushData(data);
/** Standalone form of {@link JebVM.pushCommand}; see {@link pushData}. */
export const pushCommand = <
    T extends OpcodeFunction<any, U, D, S>,
    U extends JebVM<D, S>,
    D,
    S,
>(
    vm: U,
    cmd: T,
    ...args: GetArgParams<T>
) => vm.pushCommand(cmd, ...args);
/** Standalone form of {@link JebVM.popData}; see {@link pushData}. */
export const popData = <T extends JebVM<any, any>>(vm: T) => vm.popData();
/** Standalone form of {@link JebVM.popNData}; see {@link pushData}. */
export const popNData = <T extends JebVM<any, any>>(vm: T, n: number) =>
    vm.popNData(n);
/** Standalone form of {@link JebVM.peekData}; see {@link pushData}. */
export const peekData = <T extends JebVM<any, any>>(vm: T) => vm.peekData();

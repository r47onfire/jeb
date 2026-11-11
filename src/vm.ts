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
    StackTreeNode,
} from "./errors";
import { SourceInfo, sourcesEqual } from "./ir";
import { CallArgs, OP_eval, OP_throw, OpcodeHandler } from "./opcodes";
import { Identifier } from "./utils";

/**
 * Data for the command: an opcode function plus its immediate arguments. `D` is
 * the type of the values the VM runs (chosen by the layer above; the core
 * itself only ever holds them opaquely), and `S` is the span type carried by
 * the IR the VM runs.
 */
export type Command<D = any, S = any, C = any, A extends any[] = any[]> = [
    opcode: OpcodeFunction<A, D, S, C>,
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
export type OpcodeFunction<A extends any[], D = any, S = any, C = any> = (
    vm: JebVM<D, S, C>,
    ...args: A
) => void;

/**
 * Extracts the type of an opcode function's immediate arguments (everything
 * after the VM parameter), for typing calls to {@link JebVM.pushCommand}.
 */
export type GetArgParams<T extends OpcodeFunction<any, any, any, any>> =
    Parameters<T>[1] extends infer T extends any[] ? T : [void];

/** Base VM for running JEB code */
export abstract class JebVM<
    D = any,
    S = any,
    C = any,
> extends EventDispatcher<JEBAuditEvents> {
    /** Current environment */
    currentEnv!: Env<D>;
    /** Stack of commands to execute */
    commandStack!: LinkedList<Command<D, S, C>>;
    /** Stack of values */
    dataStack!: LinkedList<D>;
    /** Current dynamic wind stack (linked list / tree) */
    curDynamicWind!: DynamicWind<D, S, C>;
    /** Whether the VM is paused */
    paused!: boolean;
    /** The Promise that the VM is currently waiting on */
    awaiting: Promise<void> | null = null;
    /** Callstack entries */
    tracebackStack!: LinkedList<StackCount<S>>;
    /**
     * The opcode table: maps an IR node's opcode name to the handler that
     * evaluates it. The core opcodes are installed by the constructor; hosts
     * and higher layers register more with {@link defineOpcode}.
     */
    opcodes: Record<string, OpcodeHandler<D, S, C>> = {};
    /**
     * Sources of the macro expansions the evaluator is currently inside,
     * outermost first. A node's own source link (`expandedFrom`) is pushed here
     * while its subtree runs, so nested code can see the full expansion context
     * it was generated in.
     */
    expansionStack: SourceInfo<S>[] = [];
    /**
     * The error that stopped the VM, if any; {@link step} rethrows it while set.
     * It is a value of the layer's own error type (see {@link createError} and
     * {@link isError}), not necessarily a {@link JEBError}: the layer's errors
     * are ordinary values of type `D` that can end up on the stack.
     */
    error: D | undefined;
    /**
     * Hook for VM subclasses with extra state beyond the base stacks: returns a
     * snapshot of that state, so continuations and dynamic-wind can save and
     * restore it. The base VM has no extra state.
     */
    getState(): any {}
    /** Counterpart to {@link getState}: restores a snapshot it returned earlier. */
    restoreState(state: any): void {}

    /**
     * Hook: the layer's `None` value (unit type) -- the value of expressions
     * that produce a value but have nothing in particular to produce (an empty
     * block, a conditional whose condition is false and that has no else
     * branch, and so on). Must return the same value on every call: opcodes
     * compare against it by identity.
     */
    abstract noneValue(): D;
    /**
     * Hook: the layer's Ellipsis value -- the "no value" sentinel, distinct
     * from {@link noneValue}. Sequencing skips over this and returns the last
     * real value encountered. Must return the same value on every call: opcodes
     * compare against it by identity.
     */
    abstract noValue(): D;
    /**
     * Hook: builds an error value of the layer's error type from a message. The
     * implementation should attach the current traceback (see
     * {@link tracebackArray}) to the error object itself.
     */
    abstract createError(message: string): D;
    /**
     * Hook: whether the given value is an error of the layer's error type.
     * {@link step} consults it for everything thrown through it: error values
     * are unwound through the dynamic-wind stack (see `OP_throw`), anything
     * else is rethrown to the host untouched.
     */
    abstract isError(value: unknown): boolean;

    /**
     * Hook: executes one code node (of the layer's code type `C`) in tail
     * position or not, leaving exactly one result on the data stack (or
     * scheduling the commands that do). This is the core's only way of running
     * code: the core does not know the code representation, so sequences,
     * argument evaluation, and {@link start} all route through here (via the
     * `OP_eval` command). A Lisp-IR implementation of this hook ships in the
     * package's test module (`indextest`); a layer with its own code
     * representation (e.g. Kuiper executing CST nodes directly) implements its
     * own.
     */
    abstract evalNode(node: C, tail: boolean): void;
    /**
     * Hook: the location (span, of type `S`) of a code node, or `undefined` if
     * it has none. Lets code that walks nodes (the layer's {@link evalNode}
     * implementation, macro expansion, error reporting) ask the layer's code
     * representation where a node came from without the core knowing the
     * representation.
     */
    abstract getLocation(node: C): S | undefined;
    /**
     * Hook: queues whatever calling is needed to convert a value to a boolean
     * -- in Kuiper, a `__bool__` call on it -- leaving exactly one result (the
     * converted value) on the data stack. The caller then decides with
     * {@link isTruthy}. A layer whose values need no conversion just pushes the
     * value back.
     */
    abstract boolify(value: D): void;
    /**
     * Hook: whether a (boolified) value counts as true. Counterpart to
     * {@link booleanValue}.
     */
    abstract isTruthy(value: D): boolean;
    /**
     * Hook: the layer's boolean value for a host boolean, like {@link noneValue}
     * and {@link noValue} for their values. Used by the core itself where a
     * boolean must be materialized as a value (e.g. the `isFromContinuation`
     * flags handed to dynamic-wind handlers).
     */
    abstract booleanValue(value: boolean): D;
    /**
     * Hook: reads a variable. The core's environments are a mechanism, not a
     * policy: a layer whose current environment is itself a value (e.g. a
     * Kuiper scope object) routes variable access through these hooks instead.
     * Throws (through {@link createError}) if the name is unbound.
     */
    abstract getVariable(name: Identifier): D;
    /** Hook: defines (or redefines) a variable in the current environment. */
    abstract defineVariable(
        name: Identifier,
        value: D,
        constant: boolean,
    ): void;
    /**
     * Hook: assigns to an existing variable. Throws (through
     * {@link createError}) if the name is unbound or constant.
     */
    abstract assignVariable(name: Identifier, value: D): void;

    constructor() {
        super();
        this.reset();
    }
    /**
     * Registers an opcode handler under the given name. Throws if the name is
     * already taken: there is only ever one handler per opcode.
     */
    defineOpcode(name: string, handler: OpcodeHandler<D, S, C>) {
        if (Reflect.has(this.opcodes, name))
            throw new Error(`opcode ${name} is already defined`);
        this.opcodes[name] = handler;
    }
    /**
     * The one calling-dispatch point: given a callee and its argument nodes,
     * make the call happen, leaving exactly one result on the data stack (or
     * scheduling the commands that do). The arguments arrive unevaluated --
     * which of them get evaluated, in what order, and which are deferred (as
     * blocks) or skipped is the callee side's decision, not the `call`
     * opcode's; see {@link CallArgs} and `evalCallArgs`.
     *
     * The core runtime deliberately does not know how to call anything: which
     * values are callable, and what calling them does, is determined entirely
     * by the thing that uses JEB. A subclass must implement this method to
     * provide real calling. Everything in the core that needs to call a value
     * (the `call` opcode, `callcc`, `dynamic-wind`, the dynamic-wind handler
     * calls made by continuations and by error unwinding) routes through the
     * {@link OP_call_invoke} command, which delegates here.
     */
    abstract dispatchCall(call: CallArgs<D, S, C>): void;

    /** Pushes a value onto the data stack. */
    pushData(value: any) {
        this.dataStack = LinkedList_push(this.dataStack, value);
        // console.log("push data", value);
    }
    /** Throws if the data stack holds fewer than `n` values. */
    #checkStack(n: number) {
        if (LinkedList_length(this.dataStack) < n)
            throw this.createError("data stack underflow");
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
    pushCommand<TOpcode extends OpcodeFunction<any, D, S, C>>(
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
            throw this.createError("opcode stack underflow");
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
            if (!this.isError(e)) throw e;
            this.pushCommand(OP_throw, e as D);
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
    start(code: C) {
        if (LinkedList_length(this.commandStack) > 0)
            throw new Error("VM is already running");
        pushCommand(this, OP_eval, code, true);
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to
     * the initial empty state. Does not clear the opcode table.
     */
    reset() {
        this.paused = false;
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.expansionStack = [];
        this.currentEnv = this.createEnv();
        this.curDynamicWind = new DynamicWind(this);
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
            this.pushCommand(OP_throw, this.createError("too much recursion"));
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
        callsiteSource: SourceInfo<S> | undefined,
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
        if (!cur) throw this.createError("traceback stack underflow");

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
    newDynamicWind(): DynamicWind<D, S, C> {
        return new DynamicWind<D, S, C>(this);
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
    cc(...extraOps: Command<D, S, C>[]) {
        return new Continuation(this, extraOps);
    }
}

/**
 * Standalone form of {@link JebVM.pushData}, for opcodes (which receive the VM
 * and their arguments separately rather than as a method receiver).
 */
export const pushData = <D, S, C>(vm: JebVM<D, S, C>, data: any) =>
    vm.pushData(data);
/** Standalone form of {@link JebVM.pushCommand}; see {@link pushData}. */
export const pushCommand = <TOpcode extends OpcodeFunction<any, D, S>, D, S>(
    vm: JebVM<D, S>,
    cmd: TOpcode,
    ...args: GetArgParams<TOpcode>
) => vm.pushCommand(cmd, ...args);
/** Standalone form of {@link JebVM.popData}; see {@link pushData}. */
export const popData = <D, S, C>(vm: JebVM<D, S, C>) => vm.popData();
/** Standalone form of {@link JebVM.popNData}; see {@link pushData}. */
export const popNData = <D, S>(vm: JebVM<D, S>, n: number) => vm.popNData(n);
/** Standalone form of {@link JebVM.peekData}; see {@link pushData}. */
export const peekData = <D, S, C>(vm: JebVM<D, S, C>) => vm.peekData();

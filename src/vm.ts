import { loadBuiltins } from "./builtins";
import { Continuation, DynamicWind } from "./continuation";
import { Accessor, Applier, Evaluator } from "./dispatch";
import { Env } from "./env";
import { createStackInnerNode, createStackLeafNode, jsError, StackTreeNode } from "./errors";
import { Linked, LinkedList, llLength, llPop, llPopN, llPush } from "./linked_list";
import { Arithmetic } from "./overload";

/**
 * Data for the command
 */
export type Command = [opcode: string, ...immediateArgs: any[]];
export interface StackCount extends Linked<string> {
    readonly count: number;
    readonly isTailCalled: boolean;
}

/**
 * Function that implements an opcode for the VM by pushing instructions or pushing and popping data.
 */
export type OpcodeFunction<T extends JebVM> = (vm: T, args: any[]) => void;

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
    paused = false;
    /** callstack entries */
    tracebackStack!: StackCount | null;
    /** Environment that all builtins live in */
    builtinsEnv = this.createEnv();
    opcodeTable: Record<string, [impl: OpcodeFunction<this>, doc: string | null]> = {};
    applyTable: Applier<any>[] = [];
    evalTable: Evaluator<any>[] = [];
    accessTable: Accessor<any>[] = [];

    constructor(public math = new Arithmetic) {
        this.reset();
        loadBuiltins(this);
    }
    pushData(value: any) {
        this.dataStack = llPush(this.dataStack, value);
    }
    #checkStack(n: number) {
        if (llLength(this.dataStack) < n) throw new Error("Data stack underflow");
    }
    popNData(n: number) {
        this.#checkStack(n);
        const { 0: values, 1: rest } = llPopN(this.dataStack!, n);
        this.dataStack = rest;
        return values.reverse();
    }
    popData() {
        this.#checkStack(1);
        const { 0: value, 1: rest } = llPop(this.dataStack!);
        this.dataStack = rest;
        return value;
    }
    peekData() {
        this.#checkStack(1);
        return this.dataStack!.value;
    }
    pushCommand(name: string, ...args: any[]) {
        this.commandStack = llPush(this.commandStack, [name, ...args]);
    }
    #popCommand() {
        if (llLength(this.commandStack) === 0) throw new Error("Opcode stack underflow");
        const { 0: value, 1: rest } = llPop(this.commandStack!);
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
        if (llLength(this.commandStack) === 0) return false;
        const command = this.#popCommand();
        const opcode = this.opcodeTable[command[0]];
        if (!opcode) throw new Error(`Unknown opcode: ${command[0]}`);
        opcode[0](this, command.slice(1));
        return true;
    }

    /**
     * Starts running the code
     * @param code Code to run
     * @throws if the VM is already running (i.e. there are commands on the command stack)
     */
    start(code: any) {
        if (llLength(this.commandStack) > 0) throw new Error("VM is already running");
        this.pushData(code);
        this.pushCommand("jeb:eval");
    }
    /**
     * Silently stops running the code, by resetting all stacks state back to the initial empty state.
     * Does not clear the global or builtins env.
     */
    reset() {
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.currentEnv = this.createEnv(this.builtinsEnv);
        this.curDynamicWind = new DynamicWind(this);
    }
    /**
     * Gets the length of the command stack.
     */
    get recursionDepth() {
        return llLength(this.commandStack);
    }
    /**
     * If the {@link recursionDepth} is larger than the given length, adds an error to the command stack
     * to signal to the running program that it's recursing too much
     * @param length Maximum length before an error is added
     */
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand("jeb:throw", "jeb:recursion_error", "too much recursion", {});
        }
    }
    /**
     * Returns the names of the functions in the call stack, with innermost first
     * @returns list of stack entries, with only 1-element repeats compressed.
     */
    tracebackArray() {
        var stack = this.tracebackStack;
        const parts: StackTreeNode[] = [];
        var prevName: string | undefined, prevCount = 0;
        const flush = () => {
            if (prevCount > 0) {
                const leaf = createStackLeafNode(prevName!);
                parts.push(prevCount > 1 ? createStackInnerNode(prevCount, [leaf]) : leaf);
            }
            prevCount = 0;
        };
        while (stack) {
            if (prevName !== stack.value) flush();
            prevName = stack.value;
            prevCount += stack.count;
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
    tracebackPush(func: string, tailcallHint: boolean) {
        const top = this.tracebackStack;
        if (top && top.value === func && top.isTailCalled === tailcallHint) {
            // same name and type = just bump the counter
            this.tracebackStack = {
                value: func,
                count: top.count + 1,
                next: top.next,
                isTailCalled: tailcallHint
            };
        } else {
            this.tracebackStack = {
                value: func,
                count: 1,
                next: top,
                isTailCalled: tailcallHint
            };
        }
    }
    /**
     * Drops all the tail-call entries off the stack, and then one more
     */
    tracebackPop() {
        var cur = this.tracebackStack;
        if (!cur) throw new Error("Traceback stack underflow");

        // drop all TCO'ed frames
        while (cur && cur.isTailCalled) {
            cur = cur.next;
        }

        if (!cur) {
            // oops, all tail calls
            this.tracebackStack = null;
            return;
        }

        // normal frame pop
        if (cur.count > 1) {
            this.tracebackStack = {
                value: cur.value,
                count: cur.count - 1,
                next: cur.next,
                isTailCalled: false
            };
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
    fatalError(type: string, message: string): never {

        return jsError(type, message, this.tracebackArray());
    }
}

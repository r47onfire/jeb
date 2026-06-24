import { loadBuiltins } from "./builtins";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { jsError } from "./errors";
import { Linked, LinkedList, llLength, llPop, llPopN, llPush, llPushArray } from "./linked_list";
import { Arithmetic, Type, TypeFor } from "./overload";

/**
 * Used to specify the number of arguments that a function can be called with.
 * A single number means min = max = that number, and null means min = 0, max = Infinity.
 */
export type Arity = { min: number, max: number } | number | null;

// MARK: class Applier
/**
 * Utility object that handles when an object of the specified type is called.
 */

export abstract class Applier<T> {
    constructor(
        /**
         * The type that this applier works with.
         */
        public readonly type: Type
    ) { }
    /**
     * Performs the application
     * @param func The thing in function position that is being applied.
     * @param alreadyEvaluated True if the arguments provided are from a synthetic/implicit application, and should not be re-evaluated, even if it's not a macro
     * @param tailcallHint True if this application is a tail call.
     * @param args The unevaluated arguments
     * @param vm The VM to evaluate in
     */
    abstract apply(func: TypeFor<T>, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM): void;
    /**
     * Gets the name of the function to appear in tracebacks, if undefined is returned it means it's a hidden callframe and won't show.
     * Note: the apply opcode uses this to determine whether to insert a `jeb:tb_pop` opcode, but it relies on this applier's {@link apply}
     * method to add the corresponding `jeb:tb_push` opcode.
     */
    abstract getNameOf(func: TypeFor<T>): string | undefined;
    /**
     * Gets the minimum and maximum arguments for the function call, this is checked before {@link apply} is called.
     */
    abstract getArity(func: TypeFor<T>): Arity;
    /**
     * Returns true if the functor being called is a macro, and the result should be evaluated again in its caller's scope.
     */
    abstract getIsMacro(func: TypeFor<T>): boolean;
}
// MARK: class JebVM

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
    /** environment that module-level globals live in */
    globalEnv = this.createEnv(this.builtinsEnv);
    opcodeTable: Record<string, OpcodeFunction<this>> = {};
    applyTable: Applier<any>[] = [];

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
        const { values, rest } = llPopN(this.dataStack!, n);
        this.dataStack = rest;
        return values.reverse();
    }
    popData() {
        this.#checkStack(1);
        const { value, rest } = llPop(this.dataStack!);
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
    getVar(name: string) {
        return this.currentEnv.get(name);
    }
    setVar(name: string, value: any) {
        return this.currentEnv.set(name, value);
    }
    defineVar(name: string, value: any) {
        this.currentEnv.define(name, value);
    }
    constantVar(name: string, value: any) {
        this.currentEnv.constant(name, value);
    }
    #popCommand() {
        if (llLength(this.commandStack) === 0) throw new Error("Opcode stack underflow");
        const { value, rest } = llPop(this.commandStack!);
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
        const opcodeFunction = this.opcodeTable[command[0]];
        if (!opcodeFunction) throw new Error(`Unknown opcode: ${command[0]}`);
        opcodeFunction(this, command.slice(1));
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
        this.curDynamicWind = new DynamicWind(this.currentEnv = this.createEnv(this.globalEnv));
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
     * @returns A list of strings for each call frame
     */
    // TODO: don't expand the repeats! it should be able to take advantage of them to compress faster
    tracebackArray() {
        var stack = this.tracebackStack;
        const parts: string[] = [];
        while (stack) {
            for (var i = 0; i < stack.count; i++) parts.push(stack.value);
            stack = stack.next;
        }
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
        return new DynamicWind(
            this.currentEnv,
            this.curDynamicWind,
            this.commandStack,
            this.dataStack,
        );
    }
    createEnv(...parents: Env[]) {
        return new Env({}, parents);
    }
    /**
     * Returns the current continuation at this state.
     * @param extraOps Extra opcodes to push to the command stack *when this continuation is invoked* (not now).
     */
    cc(...extraOps: Command[]) {
        return new Continuation(
            this.currentEnv,
            llPushArray(this.commandStack, extraOps),
            this.dataStack,
            this.curDynamicWind,
            this.tracebackStack,
        );
    }
    fatalError(type: string, message: string): never {
        return jsError(type, message, this.tracebackArray());
    }
}

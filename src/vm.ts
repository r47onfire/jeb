import { DynamicWind } from "./continuation";
import { Env } from "./env";
import { loadBuiltins } from ".";
import { Linked, LinkedList, llPush, llLength, llPopN, llPop, llToArray } from "./linked_list";
import { Type, Arithmetic } from "./overload";

// MARK: class Applier

export abstract class Applier<T> {
    constructor(
        public readonly type: Type
    ) { }
    abstract apply(func: T, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM): void;
    abstract getNameOf(func: T): string | undefined;
    abstract getArity(func: T): { min: number; max: number; } | number | null;
    abstract getIsMacro(func: T): boolean;
}
// MARK: class JebVM

export type Command = [string, ...any[]];
export interface StackCount extends Linked<string> {
    readonly count: number;
    readonly isTailCalled: boolean;
}

export type OpcodeFunction = (vm: JebVM, args: any[]) => void;

export class JebVM {
    /** current environment */
    currentEnv = new Env;
    /** stack of commands to execute */
    commandStack: LinkedList<Command> = null;
    /** stack of values */
    dataStack: LinkedList<any> = null;
    /** current dynamic wind stack (linked list / tree) */
    curDynamicWind = new DynamicWind(this.currentEnv);
    /** whether the VM is paused */
    paused = false;
    /** callstack entries */
    tracebackStack: StackCount | null = null;
    globalEnv = new Env;
    opcodeTable: Record<string, OpcodeFunction> = {};
    applyTable: Applier<any>[] = [];

    constructor(public math = new Arithmetic) {
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
        return values;
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
        var x = this.currentEnv.get(name);
        if (!x.ok) x = this.globalEnv.get(name);
        return x;
    }
    setVar(name: string, value: any) {
        if (!this.currentEnv.set(name, value)) {
            if (!this.globalEnv.set(name, value)) {
                this.globalEnv.define(name, value);
            }
        }
    }
    #popCommand() {
        if (llLength(this.commandStack) === 0) throw new Error("Opcode stack underflow");
        const { value, rest } = llPop(this.commandStack!);
        this.commandStack = rest;
        return value;
    }
    step(debug: boolean = false) {
        if (this.paused) return false;
        if (llLength(this.commandStack) === 0) return false;
        const command = this.#popCommand();
        if (debug) console.log("Executing opcode:", command, {
            commandStack: llToArray(this.commandStack),
            dataStack: llToArray(this.dataStack),
            tracebackStack: llToArray(this.tracebackStack),
            curDynamicWind: this.curDynamicWind
        });
        const opcodeFunction = this.opcodeTable[command[0]];
        if (!opcodeFunction) throw new Error(`Unknown opcode: ${command[0]}`);
        opcodeFunction(this, command.slice(1));
        return true;
    }

    start(code: any) {
        if (llLength(this.commandStack) > 0) throw new Error("VM is already running");
        this.pushData(code);
        this.pushCommand("eval");
    }
    reset() {
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.curDynamicWind = new DynamicWind(this.currentEnv = new Env);
    }
    get recursionDepth() {
        return llLength(this.commandStack);
    }
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand("throw", "recursion_error", "too much recursion", {});
        }
    }
    tracebackArray() {
        var stack = this.tracebackStack;
        const parts: string[] = [];
        while (stack) {
            for (var i = 0; i < stack.count; i++) parts.push(stack.value);
            stack = stack.next;
        }
        return parts;
    }
}

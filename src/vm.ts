import { loadBuiltins } from "./builtins";
import { Continuation, DynamicWind } from "./continuation";
import { Env } from "./env";
import { jsError } from "./errors";
import { Linked, LinkedList, llLength, llPop, llPopN, llPush, llPushArray } from "./linked_list";
import { Arithmetic, Type, TypeFor } from "./overload";

// MARK: class Applier

export abstract class Applier<T> {
    constructor(
        public readonly type: Type
    ) { }
    abstract apply(func: TypeFor<T>, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM): void;
    abstract getNameOf(func: TypeFor<T>): string | undefined;
    abstract getArity(func: TypeFor<T>): { min: number; max: number; } | number | null;
    abstract getIsMacro(func: TypeFor<T>): boolean;
}
// MARK: class JebVM

export type Command = [string, ...any[]];
export interface StackCount extends Linked<string> {
    readonly count: number;
    readonly isTailCalled: boolean;
}

export type OpcodeFunction<T extends JebVM> = (vm: T, args: any[]) => void;

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
    builtinsEnv = this.createEnv();
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
        return this.currentEnv.get(name);
    }
    setVar(name: string, value: any) {
        return this.currentEnv.set(name, value);
    }
    defineVar(name: string, value: any) {
        this.currentEnv.define(name, value);
    }
    #popCommand() {
        if (llLength(this.commandStack) === 0) throw new Error("Opcode stack underflow");
        const { value, rest } = llPop(this.commandStack!);
        this.commandStack = rest;
        return value;
    }
    step() {
        if (this.paused) return false;
        if (llLength(this.commandStack) === 0) return false;
        const command = this.#popCommand();
        const opcodeFunction = this.opcodeTable[command[0]];
        if (!opcodeFunction) throw new Error(`Unknown opcode: ${command[0]}`);
        opcodeFunction(this, command.slice(1));
        return true;
    }

    start(code: any) {
        if (llLength(this.commandStack) > 0) throw new Error("VM is already running");
        this.pushData(code);
        this.pushCommand("jeb:eval");
    }
    reset() {
        this.commandStack = this.dataStack = this.tracebackStack = null;
        this.curDynamicWind = new DynamicWind(this.currentEnv = this.createEnv(this.globalEnv));
    }
    get recursionDepth() {
        return llLength(this.commandStack);
    }
    checkRecursion(length: number) {
        if (this.recursionDepth > length) {
            this.pushCommand("jeb:throw", "jeb:recursion_error", "too much recursion", {});
        }
    }
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
            null,
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

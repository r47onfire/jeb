import { LinkedList, LinkedList_pushAll } from "@r47onfire/game-math";
import { Env } from "./env";
import { Command, JebVM, StackCount } from "./vm";

/**
 * A continuation which holds all the VM state, and can restore it at any time
 */
export class Continuation<T extends JebVM = JebVM> {
    /** Closed-over environment */
    env: Env;
    /** Closed-over command stack in progress */
    commands: LinkedList<Command>;
    /** Closed-over data stack in progress */
    data: LinkedList<any>;
    /** Closed-over dynamic wind stack in progress */
    winders: DynamicWind;
    /** Closed-over traceback stack in progress */
    traceback: LinkedList<StackCount>;
    /** Other saved state */
    state: { [K in T["copyableState"][number]]: T[K] };
    constructor(vm: T, extraOps: Command[]) {
        this.env = vm.currentEnv;
        this.commands = LinkedList_pushAll(vm.commandStack, extraOps);
        this.data = vm.dataStack;
        this.winders = vm.curDynamicWind;
        this.traceback = vm.tracebackStack;
        this.state = Object.fromEntries(vm.copyableState.map(s => [s, vm[s]])) as any;
    }
    /**
     * Call the continuation and restore the state of the VM
     * @param vm VM to restore state of
     * @param data Result of the continuation return value
     */
    invoke(vm: T, data: any) {
        vm.currentEnv = this.env;
        vm.commandStack = this.commands;
        vm.dataStack = this.data;
        vm.tracebackStack = this.traceback;
        Object.assign(vm, this.state);
        vm.pushData(data);
        this.winders.processJumpHere(vm);
    }
}

/**
 * Data holding a dynamic wind enter/exit handler pair
 */
export interface Windable {
    enter: any;
    exit: any;
}

/**
 * Node in a dynamic wind tree
 */
export class DynamicWind<T extends JebVM = JebVM> {
    handler: Windable | null = null;
    /** current env at the point of the dynamic wind start */
    envHere: Env;
    parent: DynamicWind | null = null;
    /** closed-over command stack */
    commandsHere: LinkedList<Command> = null;
    /** closed-over data stack */
    dataHere: LinkedList<any> = null;
    /** Other saved state */
    stateHere: { [K in T["copyableState"][number]]: T[K] };
    constructor(vm: T) {
        this.envHere = vm.currentEnv;
        this.parent = vm.curDynamicWind;
        this.commandsHere = vm.commandStack;
        this.dataHere = vm.dataStack;
        this.stateHere = Object.fromEntries(vm.copyableState.map(s => [s, vm[s]])) as any;
    }
    /**
     * sets the handler after it has been processed
     */
    setHandler(handler: Windable) {
        this.handler = handler;
    }
    /**
     * processes the jump here, and adds instructions to call the enter and exit handlers
     * @param vm VM to process jump on
     */
    processJumpHere(vm: T) {
        var tp: DynamicWind | null = this;
        // find the common ancestor of from and to
        // parents: rightmost is innermost
        const parentsOfTo: DynamicWind[] = [];
        while (tp) {
            parentsOfTo.unshift(tp);
            tp = tp.parent;
        }
        const intOps: Command[] = [];
        const intData = [];
        // walk up the "from" stack, adding ops to run the exit handlers
        // when we reach the common ancestor, add ops to run the enter handlers for the "to" stack
        var i = -1;
        var fp: DynamicWind | null = vm.curDynamicWind;
        while (fp) {
            i = parentsOfTo.indexOf(fp);
            if (i !== -1) break;
            if (fp.handler?.exit) {
                intOps.push(["jeb:apply", [true, null, null, null], true]);
                intOps.push(["jeb:shuffle", 1, []]);
                intData.push(fp.handler.exit);
            }
            fp = fp.parent;
        }
        for (var j = i + 1; j < parentsOfTo.length; j++) {
            const tp = parentsOfTo[j]!;
            if (tp.handler?.enter) {
                intOps.push(["jeb:apply", [true], true]);
                intOps.push(["jeb:shuffle", 1, []]);
                intData.push(tp.handler.enter);
            }
        }
        // then dump everything into the VM's opcode and data stacks
        while (intOps.length > 0) vm.pushCommand(...intOps.pop()!);
        while (intData.length > 0) vm.pushData(intData.pop()!);
        // restore values
        vm.curDynamicWind = this;
    }
    /**
     * Restores the dynamic wind state when an error occurs
     * @param vm VM to restore to
     */
    restore(vm: T) {
        vm.commandStack = this.commandsHere;
        vm.dataStack = this.dataHere;
        vm.currentEnv = this.envHere;
        Object.assign(vm, this.stateHere);
    }
}

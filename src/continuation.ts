import { LinkedList, LinkedList_pushAll } from "@r47onfire/game-math";
import { OP_apply, OP_shuffle } from "./builtins";
import { Env } from "./env";
import { Command, JebVM, pushCommand, pushData, StackCount } from "./vm";

/**
 * A continuation which holds all the VM state, and can restore it at any time
 */
export class Continuation<T extends JebVM> {
    /** Closed-over environment */
    env: Env;
    /** Closed-over command stack in progress */
    commands: LinkedList<Command<T>>;
    /** Closed-over data stack in progress */
    data: LinkedList<any>;
    /** Closed-over dynamic wind stack in progress */
    winders: DynamicWind<T>;
    /** Closed-over traceback stack in progress */
    traceback: LinkedList<StackCount>;
    /** Other saved state */
    state: any;
    constructor(vm: T, extraOps: Command<T>[]) {
        this.env = vm.currentEnv;
        this.commands = LinkedList_pushAll(vm.commandStack, extraOps);
        this.data = vm.dataStack;
        this.winders = vm.curDynamicWind;
        this.traceback = vm.tracebackStack;
        this.state = vm.getState();
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
        vm.restoreState(this.state);
        pushData(vm, data);
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
export class DynamicWind<T extends JebVM> {
    handler: Windable | null = null;
    /** current env at the point of the dynamic wind start */
    envHere: Env;
    parent: DynamicWind<T> | null = null;
    /** closed-over command stack */
    commandsHere: LinkedList<Command<T>> = null;
    /** closed-over data stack */
    dataHere: LinkedList<any> = null;
    /** Other saved state */
    stateHere: any;
    constructor(vm: T) {
        this.envHere = vm.currentEnv;
        this.parent = vm.curDynamicWind as DynamicWind<T>;
        this.commandsHere = vm.commandStack;
        this.dataHere = vm.dataStack;
        this.stateHere = vm.getState();
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
        var tp: DynamicWind<T> | null = this;
        // find the common ancestor of from and to
        // parents: rightmost is innermost
        const parentsOfTo: DynamicWind<T>[] = [];
        while (tp) {
            parentsOfTo.unshift(tp);
            tp = tp.parent;
        }
        const intOps: Command<T>[] = [];
        const intData = [];
        // walk up the "from" stack, adding ops to run the exit handlers
        // when we reach the common ancestor, add ops to run the enter handlers for the "to" stack
        var i = -1;
        var fp: DynamicWind<T> | null = vm.curDynamicWind;
        while (fp) {
            i = parentsOfTo.indexOf(fp);
            if (i !== -1) break;
            if (fp.handler?.exit) {
                intOps.push([OP_apply, [true, null], undefined, true]);
                intOps.push([OP_shuffle, 1, []]);
                intData.push(fp.handler.exit);
            }
            fp = fp.parent;
        }
        const len = parentsOfTo.length;
        for (var j = i + 1; j < len; j++) {
            const tp = parentsOfTo[j]!;
            if (tp.handler?.enter) {
                intOps.push([OP_apply, [true], undefined, true]);
                intOps.push([OP_shuffle, 1, []]);
                intData.push(tp.handler.enter);
            }
        }
        // then dump everything into the VM's opcode and data stacks
        while (intOps.length > 0) pushCommand(vm, ...intOps.pop()!);
        while (intData.length > 0) pushData(vm, intData.pop()!);
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
        vm.restoreState(this.stateHere);
    }
}

import { LinkedList, LinkedList_pushAll } from "@r47onfire/game-math";
import { Env } from "./env";
import { SourceInfo } from "./ir";
import { OP_call_and_ignore_result } from "./opcodes";
import { Command, JebVM, pushCommand, pushData, StackCount } from "./vm";

/** A continuation which holds all the VM state, and can restore it at any time */
export class Continuation<T extends JebVM<any, any>> {
    /** Closed-over environment */
    env: Env<D>;
    /** Closed-over command stack in progress */
    commands: LinkedList<Command<T>>;
    /** Closed-over data stack in progress */
    data: LinkedList<any>;
    /** Closed-over dynamic wind stack in progress */
    winders: DynamicWind<T>;
    /** Closed-over traceback stack in progress */
    traceback: LinkedList<StackCount<S>>;
    /** Closed-over macro expansion context in progress */
    expansion: SourceInfo<any>[];
    /** Other saved state */
    state: ReturnType<T["getState"]>;
    constructor(vm: T, extraOps: Command<T, D, S>[]) {
        this.env = vm.currentEnv;
        this.commands = LinkedList_pushAll(vm.commandStack, extraOps);
        this.data = vm.dataStack;
        this.winders = vm.curDynamicWind;
        this.traceback = vm.tracebackStack;
        this.expansion = [...vm.expansionStack];
        this.state = vm.getState();
    }
    /**
     * Call the continuation and restore the state of the VM
     *
     * @param vm VM to restore state of
     * @param data Result of the continuation return value
     */
    invoke(vm: JebVM<D, S>, data: any) {
        vm.currentEnv = this.env;
        vm.commandStack = this.commands;
        vm.dataStack = this.data;
        vm.tracebackStack = this.traceback;
        vm.expansionStack = [...this.expansion];
        vm.restoreState(this.state);
        pushData(vm, data);
        this.winders.processJumpHere(vm);
    }
}

/** Data holding a dynamic wind enter/exit handler pair */
export interface Windable {
    enter: any;
    exit: any;
}

/** Node in a dynamic wind tree */
export class DynamicWind<T extends JebVM<D, S>, D, S> {
    /**
     * The enter/exit handler pair for this node; null until {@link setHandler}
     * is called
     */
    handler: Windable | null = null;
    /** Current env at the point of the dynamic wind start */
    envHere: Env<D>;
    /**
     * The enclosing dynamic-wind node, forming the tree that jumps are resolved
     * against
     */
    parent: DynamicWind<T, D, S> | null = null;
    /** Closed-over command stack */
    commandsHere: LinkedList<Command<T, D, S>> = null;
    /** Closed-over data stack */
    dataHere: LinkedList<any> = null;
    /** Other saved state */
    stateHere: ReturnType<T["getState"]>;
    constructor(vm: T) {
        this.envHere = vm.currentEnv;
        this.parent = vm.curDynamicWind as DynamicWind<T, D, S>;
        this.commandsHere = vm.commandStack;
        this.dataHere = vm.dataStack;
        this.stateHere = vm.getState();
    }
    /** Sets the handler after it has been processed */
    setHandler(handler: Windable) {
        this.handler = handler;
    }
    /**
     * Processes the jump here, and adds instructions to call the enter and exit
     * handlers
     *
     * @param vm VM to process jump on
     */
    processJumpHere(vm: T) {
        var tp: DynamicWind<T, D, S> | null = this;
        // find the common ancestor of from and to
        // parents: rightmost is innermost
        const parentsOfTo: DynamicWind<T, D, S>[] = [];
        while (tp) {
            parentsOfTo.unshift(tp);
            tp = tp.parent;
        }
        // the handler calls to run, in order: the exit handlers on the way
        // up from the current wind stack to the common ancestor (exit
        // handlers get `null` -- this jump is not an error), then the enter
        // handlers on the way back down to this node
        const calls: [callee: any, args: any[]][] = [];
        var i = -1;
        var fp: DynamicWind<T, D, S> | null = vm.curDynamicWind;
        while (fp) {
            i = parentsOfTo.indexOf(fp);
            if (i !== -1) break;
            if (fp.handler?.exit) calls.push([fp.handler.exit, [null]]);
            fp = fp.parent;
        }
        const len = parentsOfTo.length;
        for (var j = i + 1; j < len; j++) {
            const tp = parentsOfTo[j]!;
            if (tp.handler?.enter) calls.push([tp.handler.enter, []]);
        }
        // commands run last-pushed-first, so push the calls in reverse
        for (var k = calls.length - 1; k >= 0; k--)
            pushCommand(
                vm,
                OP_call_and_ignore_result,
                calls[k]![0],
                calls[k]![1],
            );
        // restore values
        vm.curDynamicWind = this;
    }
    /**
     * Restores the dynamic wind state when an error occurs
     *
     * @param vm VM to restore to
     */
    restore(vm: T) {
        vm.commandStack = this.commandsHere;
        vm.dataStack = this.dataHere;
        vm.currentEnv = this.envHere;
        vm.restoreState(this.stateHere);
    }
}

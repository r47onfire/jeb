import { Env } from "./env";
import { Command, StackCount, JebVM } from "./vm";
import { LinkedList, llPushArray } from "./linked_list";

export class Continuation {

    constructor(
        public env: any,
        public commands: LinkedList<Command>,
        public data: LinkedList<any>,
        public winders: DynamicWind,
        public traceback: StackCount | null
    ) {
    }
    static fromVM(vm: JebVM, ...extraOps: Command[]) {
        return new Continuation(vm.currentEnv, llPushArray(vm.commandStack, extraOps), vm.dataStack, vm.curDynamicWind, vm.tracebackStack);
    }
    invoke(vm: JebVM, data: any) {
        vm.currentEnv = this.env;
        vm.commandStack = this.commands;
        vm.dataStack = this.data;
        vm.tracebackStack = this.traceback;
        vm.pushData(data);
        this.winders.processJumpHere(vm);
    }
}

export interface Windable {
    enter: any;
    exit: any;
}

export class DynamicWind {
    constructor(
        public envHere: Env,
        public parent: DynamicWind | null = null,
        public handler: Windable | null = null,
        public commandsHere: LinkedList<Command> = null,
        public dataHere: LinkedList<any> = null,
    ) { }

    static fromVM(vm: JebVM) {
        return new DynamicWind(
            vm.currentEnv,
            vm.curDynamicWind,
            null,
            vm.commandStack,
            vm.dataStack,
        );
    }
    setHandler(handler: Windable) {
        this.handler = handler;
        return this;
    }
    processJumpHere(vm: JebVM) {
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
                intOps.push(["apply", [true, null, null, null], true]);
                intOps.push(["shuffle", 1, []]);
                intData.push(fp.handler.exit);
            }
            fp = fp.parent;
        }
        for (var j = i + 1; j < parentsOfTo.length; j++) {
            const tp = parentsOfTo[j]!;
            if (tp.handler?.enter) {
                intOps.push(["apply", [true], true]);
                intOps.push(["shuffle", 1, []]);
                intData.push(tp.handler.enter);
            }
        }
        // then dump everything into the VM's opcode and data stacks
        while (intOps.length > 0) vm.pushCommand(...intOps.pop()!);
        while (intData.length > 0) vm.pushData(intData.pop()!);
        // restore values
        vm.curDynamicWind = this;
    }
    restore(vm: JebVM) {
        vm.commandStack = this.commandsHere;
        vm.dataStack = this.dataHere;
        vm.currentEnv = this.envHere;
    }
}

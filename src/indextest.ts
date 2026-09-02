import { define, makeJSFun } from "./define";
import { Identifier } from "./utils";
import { JebVM } from "./vm";

export const makeTestRun = <T extends JebVM, U>(f: new () => T) => (testfun: (name: string, body: () => U) => void, name: string, testBody: (vm: T, out: string[]) => U) => {
    const vm = new f();
    const out: string[] = [];
    // simple print hook for the tests
    define(vm, "print", makeJSFun("print", ["args", true], ({ args }) => void out.push(args.map(String).join(" ")), "test print"));
    testfun(name, () => testBody(vm, out));
}

export const run = <T extends JebVM>(vm: T, code: any, steps = Infinity, recursionLimit = 10000) => {
    vm.start(code);
    for (var i = 0; i < steps; i++) {
        if (!vm.step()) return true;
        vm.checkRecursion(recursionLimit);
    }
    return false;
}

export const runAsync = async <T extends JebVM>(vm: T, code: any, steps = Infinity, recursionLimit = 10000) => {
    vm.start(code);
    for (var i = 0; i < steps; i++) {
        await vm.awaiting;
        vm.step();
        vm.checkRecursion(recursionLimit);
    }
    return false;
}

export const rawTraceback = (vm: JebVM) => {
    const res: (Identifier | undefined)[] = [];
    var t = vm.tracebackStack;
    while (t) { res.push(t.value.name); t = t.next; }
    return res;
}

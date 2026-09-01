import { define, makeJSFun } from "./define";
import { Identifier } from "./utils";
import { JebVM } from "./vm";

export const makeTestRun = (f: new () => JebVM) => (testfun: (name: string, body: () => void) => void, name: string, testBody: (vm: JebVM, out: string[]) => void) => {
    const vm = new f();
    const out: string[] = [];
    // simple print hook for the tests
    define(vm, "print", makeJSFun("print", ["args", true], ({ args }) => void out.push(args.map(String).join(" ")), "test print"));
    testfun(name, () => testBody(vm, out));
}

export const run = (vm: JebVM, code: any, steps = Infinity, recursionLimit = 10000) => {
    vm.start(code);
    for (var i = 0; i < steps; i++) {
        if (!vm.step()) return true;
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

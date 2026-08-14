import { isinstance } from "@r47onfire/game-math";
import { JebVM } from "../vm";
import { defineOpcode, defineUnwrapper } from "./define";
import { ReferenceWrapper, Wrapper } from "../wrapper";

export const registerUnwrap = (vm: JebVM) => {
    defineOpcode(vm, "jeb:wrap", (vm, args) => {
        const item = vm.popData();
        const cls = args[0];
        vm.pushData(new cls(item, ...args.slice(1)));
    },
        `.imm cls args...
.param {constructor function} cls - the class constructor to use - must return instance of \`Wrapper\`
.param {any} args... - the parameters to pass into the constructor after the object
.sed obj -- wrapped
. Wraps the object in the given wrapper class.`);
    defineOpcode(vm, "jeb:unwrap", (vm, { 0: dontUnwrap }) => {
        const top = vm.peekData();
        if (isinstance(top, Wrapper) && !dontUnwrap.includes(top.flag)) {
            vm.popData();
            vm.pushCommand("jeb:unwrap", dontUnwrap);
            vm.getProtocol(false, true, "unwrap", [top]).run(vm, [top]);
        }
    },
        `.imm dontUnwrap
.param {string[]} dontUnwrap
.sed value -- unwrapped
. Unwraps all wrappers from the value, unless the value's wrapper has a tag in the given list of \`dontUnwrap\`.`);
    defineUnwrapper(vm, [ReferenceWrapper], (vm, { 0: wrapper }) => {
        vm.pushData(wrapper.obj);
        vm.pushCommand("jeb:get", true);
    }, "Unwraps a reference");
}

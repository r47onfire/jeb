import { isinstance } from "@r47onfire/game-math";
import { JebVM, peekData, popData, pushCommand, pushData } from "./vm";
import { defineOpcode, defineUnwrapper } from "./define";
import { MacroWrapper, ReferenceWrapper, Wrapper } from "./wrapper";

export const registerUnwrap = (vm: JebVM) => {
    defineOpcode(vm, "jeb:wrap", (vm, args) => {
        const item = popData(vm);
        const cls = args[0];
        pushData(vm, new cls(item, ...args.slice(1)));
    },
        `.imm cls args...
.param {constructor function} cls - the class constructor to use - must return instance of \`Wrapper\`
.param {any} args... - the parameters to pass into the constructor after the object
.sed obj -- wrapped
. Wraps the object in the given wrapper class.`);
    defineOpcode(vm, "jeb:unwrap", (vm, { 0: dontUnwrap }) => {
        const top = peekData(vm);
        if (isinstance(top, Wrapper) && !dontUnwrap.includes(top.flag)) {
            popData(vm);
            pushCommand(vm, "jeb:unwrap", dontUnwrap);
            vm.getProtocol(false, true, "unwrap", [top]).run(vm, [top]);
        }
    },
        `.imm dontUnwrap
.param {string[]} dontUnwrap
.sed value -- unwrapped
. Unwraps all wrappers from the value, unless the value's wrapper has a tag in the given list of \`dontUnwrap\`.`);
    defineUnwrapper(vm, [ReferenceWrapper], (vm, { 0: { obj } }) => {
        pushCommand(vm, "jeb:get", true);
        pushData(vm, obj);
    }, "Unwraps a reference");
    defineUnwrapper(vm, [MacroWrapper], (vm, { 0: { obj } }) => {
        pushCommand(vm, "jeb:eval", undefined);
        pushData(vm, obj);
    }, "Unwraps a macro expansion thing");
}

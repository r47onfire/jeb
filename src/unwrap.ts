import { isinstance } from "@r47onfire/game-math";
import { OP_eval, OP_get } from "./builtins";
import { defineUnwrapper, makeOpcode } from "./define";
import { __initializer } from "./initializers";
import { DropFirst } from "./utils";
import { peekData, popData, pushCommand, pushData } from "./vm";
import { MacroWrapper, ReferenceWrapper, Wrapper } from "./wrapper";

type WrapArg<T extends new (obj: any, ...args: any[]) => Wrapper> = [cls: T, ...extraArgs: DropFirst<ConstructorParameters<T>>];

export const OP_wrap = makeOpcode((vm, args: WrapArg<any>) => {
    const item = popData(vm);
    const cls = args[0];
    pushData(vm, new cls(item, ...args.slice(1)));
},
    `.imm cls args...
.param {constructor function} cls - the class constructor to use - must return instance of \`Wrapper\`
.param {any} args... - the parameters to pass into the constructor after the object
.sed obj -- wrapped
. Wraps the object in the given wrapper class.`);
export const OP_unwrap = makeOpcode((vm, { 0: dontUnwrap }: [string[]]) => {
    const top = peekData(vm);
    if (isinstance(top, Wrapper) && !dontUnwrap.includes(top.flag)) {
        popData(vm);
        pushCommand(vm, OP_unwrap, dontUnwrap);
        vm.getProtocol(false, true, "unwrap", [top]).run(vm, [top]);
    }
},
    `.imm dontUnwrap
.param {string[]} dontUnwrap
.sed value -- unwrapped
. Unwraps all wrappers from the value, unless the value's wrapper has a tag in the given list of \`dontUnwrap\`.`);

__initializer(vm => {
    defineUnwrapper(vm, [ReferenceWrapper], (vm, { 0: { obj } }) => {
        pushCommand(vm, OP_get, true);
        pushData(vm, obj);
    }, "Unwraps a reference");
    defineUnwrapper(vm, [MacroWrapper], (vm, { 0: { obj } }) => {
        pushCommand(vm, OP_eval, undefined, undefined, undefined);
        pushData(vm, obj);
    }, "Unwraps a macro expansion thing");
});


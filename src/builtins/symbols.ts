import { define, makeJSFun } from "../define";
import { gensym } from "../env";
import { withType } from "../typecheck";
import { JebVM } from "../vm";

export const B_sym = makeJSFun(
    "sym",
    ["name", ["unique", false]],
    (args) => {
        const { name, unique } = args;
        const name2 = withType(name, ["string"], "name", args);
        return withType(unique, ["boolean"], "unique", args)
            ? gensym(name2)
            : Symbol.for(name2);
    },
    `.func (sym name [unique])
..param {string} name
..param {boolean?} [unique=false]
. Returns a Javascript \`Symbol\` with the specified name.
If \`unique\` is true, the symbol will be non-interned (created using \`[[gensym]](name)\`) and will only be equal to itself.
If \`unique\` is false, the symbol will be interned (created using \`Symbol.for(name)\`) and will only be equal to other symbols created with the same name and \`unique=false\`.
`,
);

export const loadSymbolBuiltins = (vm: JebVM) => {
    define(vm, "sym", B_sym);
};

import { parse, stringify } from "lib0/json";
import { define, makeJSFun } from "../define";
import { ErrnoCode } from "../errno";
import { wrapThrowToError } from "../errors";
import { withType } from "../protocol";
import { JebVM } from "../vm";

export const B_jsonparse = makeJSFun("jsonParse", ["json"], ({ json }) => wrapThrowToError(ErrnoCode.ESYNTAX, () => parse(withType(json, ["string"], "json"))),
    `.func (jsonParse json)
..param {string} json
.pure
.throws ESYNTAX - if the string is not valid JSON
.returns {any}
. Parses the string using \`JSON.parse()\` and returns the object.`);
export const B_jsonstringify = makeJSFun("jsonStringify", ["value"], ({ value }) => wrapThrowToError(ErrnoCode.ERANGE, () => stringify(value)),
    `.func (jsonStringify value)
..param {any} value
.throws ERANGE - if \`value\` contains something that can't be serialized, such as a function or circular reference
.returns {string}
. Stringifies the object to JSON using \`JSON.stringify()\`.`);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadJsonBuiltins = (vm: JebVM) => {
    define(vm, "jsonParse", B_jsonparse);
    define(vm, "jsonStringify", B_jsonstringify);
};

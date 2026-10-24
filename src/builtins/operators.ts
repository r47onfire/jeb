import { id } from "lib0/function";
import { stringify } from "lib0/json";
import { add } from "lib0/math";
import { Err, Ok, Result } from "ts-res";
import { define, makeJSFun, NOTHING } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError, wrapThrowToError } from "../errors";
import { float, numberOp, Relation } from "../math";
import { theTypeName, typeOf, withType } from "../protocol";
import { JebVM, pushCommand, pushData } from "../vm";
import { OP_eval } from "./eval";

// MARK: Operators
const mathLoaders: ((vm: JebVM) => void)[] = [];
const mathHelper = (operator: string, op2: "add" | "sub" | "mul" | "matMul" | "div" | "mod" | "pow" | "bitAnd" | "bitOr" | "bitXor", op1: "abs" | "neg" | "inv" | undefined,
    f2: (a: number | bigint, b: number | bigint) => number | bigint,
    f1: (x: bigint) => any,
    doc: string,
) => {
    const b = makeJSFun(operator, ["a", ["b", NOTHING]], ({ a, b }, vm) => {
        var f: () => Result<any, any>;
        if (b === NOTHING) {
            if (op1 === undefined) {
                throw new JEBError(ErrnoCode.EINVAL, `${stringify(op2)} is not defined for one argument`);
            }
            f = () => vm.getProtocol(false, true, op1, [a]).run(vm, [a]);
        } else {
            f = () => vm.getProtocol(false, true, op2, [a, b]).run(vm, [a, b]);
        }
        return wrapThrowToError(ErrnoCode.EINVAL, f).else(e => { throw new JEBError(ErrnoCode.ERANGE, String(e)); })
    },
        `.func (${operator} a [b])
..param {any} a
..param {any?} b
.throws EPROTONOSUPPORT - if no overload was found for the given argument types
.pure
. ${doc}`);
    mathLoaders.push(vm => vm.addProtocol(op2, { type: [["number", "bigint"], ["number", "bigint"]], run: (_, { 0: a, 1: b }) => Ok(f2(a, b)), doc }));
    if (op1) {
        mathLoaders.push(vm => {
            vm.addProtocol(op1, { type: [["number", "bigint"]], run: (_, { 0: a }) => Ok(f1(a)), doc });
        });
    }
    return b;
}
export const B_plus = mathHelper("add", "add", "abs", numberOp(add), a => a > 0 ? a : -a, "Adds numbers or concatenates strings.");
const loadConcatProtocol = (vm: JebVM) => vm.addProtocol("add", { type: [["string"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(a + b), doc: "Concatenates strings" });
export const B_minus = mathHelper("sub", "sub", "neg", numberOp((a, b) => a - b), a => -a, "Subtracts numbers.\nIn the case of one number, returns the additive inverse (i.e. the negative).");
export const B_mul = mathHelper("mul", "mul", undefined, numberOp((a, b) => a * b), id, "Multiplies numbers.\nThe special case of `string * number` or `number * string` results in repeating the string N times.");
const repeat = (a: string, b: number): Result<string, string> => {
    if (b < 0) return Err("Cannot repeat a negative number of times");
    if ((b | 0) !== b) return Err("Cannot repeat a non-integer number of times");
    return Ok(a.repeat(b));
}
const loadRepeatProtocols = (vm: JebVM) => {
    vm.addProtocol("mul", { type: [["string"], ["number"]], run: (_, { 0: a, 1: b }) => Ok(repeat(a, b)), doc: "Repeats strings" });
    vm.addProtocol("mul", { type: [["number"], ["string"]], run: (_, { 0: a, 1: b }) => Ok(repeat(b, a)), doc: "Repeats strings" });
};
export const B_div = mathHelper("div", "div", "inv", (a, b) => float(a) / float(b), a => 1 / float(a), "Divides numbers.\nIn the case of one number, returns the multiplicative inverse (i.e. the reciprocal).");
export const B_mod = mathHelper("mod", "mod", undefined, numberOp((a, b) => a % b), id, "Computes the modulo of two numbers.");
export const B_pow = mathHelper("pow", "pow", undefined, numberOp((a, b) => a ** b), id, "Computes the power of numbers.\nHowever, this function still folds from the right like the other math functions, so unlike how power is notated mathematically (where `a^b^c^d^e` means `a^(b^(c^(d^e)))`), `[\"pow\", a, b, c, d, e]` is interpreted as `(((a^b)^c)^d)^e`.");
export const B_bitAnd = mathHelper("bitAnd", "bitAnd", undefined, numberOp((a, b) => a & b), id, "Computes the bitwise AND of all numbers.");
export const B_bitOr = mathHelper("bitOr", "bitOr", undefined, numberOp((a, b) => a | b), id, "Computes the bitwise OR of all numbers.");
export const B_bitXor = mathHelper("bitXor", "bitXor", undefined, numberOp((a, b) => a ^ b), id, "Computes the bitwise XOR of all numbers.");
export const B_bitInv = makeJSFun("bitInv", ["a"], ({ a }) => ~withType(a, ["number", "bigint"], "a"),
    `.func (bitInv number)
..param {number} a
.pure
. Computes the two's complement signed bitwise inverse of the number.`);

// comparisons
const comparisonHelper = (op: string, bits: Relation, doc: string) => {
    return makeJSFun(op, ["items", true], ({ items: a }, vm) => {
        const len = a.length;
        if (len < 2) return true;
        for (var i = 1; i < len; i++) {
            const arg = [a[i - 1], a[i], bits] as [any, any, Relation];
            const res = wrapThrowToError(ErrnoCode.EINVAL, () => vm.getProtocol(false, true, "cmp", arg).run(vm, arg));
            if (!res.ok) {
                throw new JEBError(ErrnoCode.ERANGE, "comparison error: " + res.error, {}, { return: vm.cc() });
            }
            if (!res.data) return false;
        }
        return true;
    },
        `.func (${op} items...)
..param {number | string} items...
.pure
. ${doc}`);
}
const compDocHelper = (phrase: string) => `True if the sequence of items is strictly ${phrase} when read from left to right.`;
export const B_eq = comparisonHelper("eq", Relation.EQUAL, "True if all of the items are equal.");
export const B_not_eq = comparisonHelper("notEq", Relation.NOT_EQ, "True if no adjacent pair of items are equal.");
export const B_less = comparisonHelper("less", Relation.LESS, compDocHelper("increasing"));
export const B_greater = comparisonHelper("greater", Relation.GREATER, compDocHelper("decreasing"));
export const B_less_eq = comparisonHelper("lessEq", Relation.LESS_EQ, compDocHelper("nondecreasing"));
export const B_greater_eq = comparisonHelper("greaterEq", Relation.GREATER_EQ, compDocHelper("nonincreasing"));

const compareFn = (_: JebVM, { 0: a, 1: b, 2: c }: [any, any, Relation]) => {
    if (a == b) return Ok(!!(c & Relation.EQUAL));
    if (a < b) return Ok(!!(c & Relation.LESS));
    if (a > b) return Ok(!!(c & Relation.GREATER));
    throw "unreachable";
};
const loadCompareProtocol = (vm: JebVM) => {
    vm.addProtocol("cmp", { type: [["number", "bigint"], ["number", "bigint"], ["number"]], run: compareFn, doc: "Compares numbers" });
    vm.addProtocol("cmp", { type: [["string"], ["string"], ["number"]], run: compareFn, doc: "Compares strings" });
    vm.addProtocol("cmp", {
        type: [[true], [true], ["number"]],
        run(_, { 0: a, 1: b, 2: c }) {
            if (a === b) return Ok(!!(c & Relation.EQUAL));
            if ((!!(c & Relation.GREATER)) !== (!!(c & Relation.LESS))) return Err(`No ordering defined for ${theTypeName(typeOf(a))} and ${theTypeName(typeOf(b))}`);
            return Ok(!!(c & Relation.LESS));
        },
        doc: "Compares any items"
    });
};

// MARK: booleans
export const B_not = makeJSFun("not", ["value"], ({ value }) => !value,
    `.func (not value)
..param {any} value
.pure
.returns {boolean}
. True if \`value\` is falsy (false, zero, undefined, null, or empty string), false otherwise.`);
const booleanHelper = (name: string, shortCircuitOn: boolean) => {
    return makeJSFun(name, ["a", [true, "b"]], ({ a, b }, vm, location) => {
        if ((!!a) === shortCircuitOn) return a;
        pushData(vm, b);
        pushCommand(vm, OP_eval, location, true);
        return NOTHING;
    },
        `.macro (fn a b)
..param {any} values...
.pure
. Boolean ${name.toUpperCase()} (short-circuits).
Evaluates \`a\`, if the result is ${shortCircuitOn ? "truthy" : "falsy"}, returns it, otherwise evaluates \`b\` and returns that.`);
}
export const B_and_shortcircuit = booleanHelper("and", false);
export const B_or_shortcircuit = booleanHelper("or", true);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadOperatorsBuiltins = (vm: JebVM) => {
    define(vm, "add", B_plus);
    define(vm, "sub", B_minus);
    define(vm, "mul", B_mul);
    define(vm, "div", B_div);
    define(vm, "mod", B_mod);
    define(vm, "pow", B_pow);
    define(vm, "bitAnd", B_bitAnd);
    define(vm, "bitOr", B_bitOr);
    define(vm, "bitXor", B_bitXor);
    define(vm, "bitInv", B_bitInv);
    define(vm, "eq", B_eq);
    define(vm, "notEq", B_not_eq);
    define(vm, "less", B_less);
    define(vm, "greater", B_greater);
    define(vm, "lessEq", B_less_eq);
    define(vm, "greaterEq", B_greater_eq);
    define(vm, "not", B_not);
    define(vm, "and", B_and_shortcircuit);
    define(vm, "or", B_or_shortcircuit);
    mathLoaders.forEach(f => f(vm));
    loadConcatProtocol(vm);
    loadRepeatProtocols(vm);
    loadCompareProtocol(vm);
};

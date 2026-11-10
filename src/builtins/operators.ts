import { id } from "lib0/function";
import { stringify } from "lib0/json";
import { add } from "lib0/math";
import { Err, Ok, Result } from "ts-res";
import { define, makeJSFun, NOTHING } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError, wrapThrowToError } from "../errors";
import { float, numberOp, Relation } from "../math";
import { theTypeName, typeOf, withType } from "../typecheck";
import { JebVM, pushCommand, pushData } from "../vm";
import { OP_eval } from "./eval";

const None = Symbol("__none__");

// MARK: Operators
const isNumeric = (x: any): x is number | bigint =>
    typeof x === "number" || typeof x === "bigint";
/**
 * Throws the error for a math operation with no implementation for the given
 * argument types (the operations are not overloadable: each has exactly the
 * implementations written out in this file).
 */
const noOverload = (name: string, args: any[]): never => {
    throw new JEBError(
        ErrnoCode.ERANGE,
        `No overload of ${name} exists for type${args.length > 1 ? "s" : ""} ${args.map((x) => theTypeName(typeOf(x))).join(", ")}`,
    );
};
const mathHelper = (
    operator: string,
    op2:
        | "add"
        | "sub"
        | "mul"
        | "matMul"
        | "div"
        | "mod"
        | "pow"
        | "bitAnd"
        | "bitOr"
        | "bitXor"
        | "shl"
        | "shr",
    op1: "abs" | "neg" | "inv" | undefined,
    f2: (a: number | bigint, b: number | bigint) => number | bigint,
    f1: (x: bigint) => any,
    doc: string,
) => {
    const binary = (a: any, b: any): Result<any, string> => {
        if (isNumeric(a) && isNumeric(b)) return Ok(f2(a, b));
        if (op2 === "add" && typeof a === "string" && typeof b === "string")
            return Ok(a + b);
        if (op2 === "mul") {
            if (typeof a === "string" && typeof b === "number")
                return repeat(a, b);
            if (typeof a === "number" && typeof b === "string")
                return repeat(b, a);
        }
        return noOverload(op2, [a, b]);
    };
    return makeJSFun(
        operator,
        ["a", ["b", None]],
        ({ a, b }) => {
            var f: () => Result<any, any>;
            if (b === None) {
                if (op1 === undefined) {
                    throw new JEBError(
                        ErrnoCode.EINVAL,
                        `${stringify(op2)} is not defined for one argument`,
                    );
                }
                f = () =>
                    isNumeric(a)
                        ? Ok((f1 as (x: number | bigint) => any)(a))
                        : noOverload(op1, [a]);
            } else {
                f = () => binary(a, b);
            }
            return wrapThrowToError(ErrnoCode.EINVAL, f).else((e) => {
                throw new JEBError(ErrnoCode.ERANGE, String(e));
            });
        },
        `.func (${operator} a [b])
..param {any} a
..param {any?} b
.throws EPROTONOSUPPORT - if no overload was found for the given argument types
.pure
. ${doc}`,
    );
};
export const B_plus = mathHelper(
    "add",
    "add",
    "abs",
    numberOp(add),
    (a) => (a > 0 ? a : -a),
    "Adds numbers or concatenates strings.",
);
export const B_minus = mathHelper(
    "sub",
    "sub",
    "neg",
    numberOp((a, b) => a - b),
    (a) => -a,
    "Subtracts numbers.\nIn the case of one number, returns the additive inverse (i.e. the negative).",
);
export const B_mul = mathHelper(
    "mul",
    "mul",
    undefined,
    numberOp((a, b) => a * b),
    id,
    "Multiplies numbers.\nThe special case of `string * number` or `number * string` results in repeating the string N times.",
);
const repeat = (a: string, b: number): Result<string, string> => {
    if (b < 0) return Err("Cannot repeat a negative number of times");
    if ((b | 0) !== b)
        return Err("Cannot repeat a non-integer number of times");
    return Ok(a.repeat(b));
};
export const B_div = mathHelper(
    "div",
    "div",
    "inv",
    (a, b) => float(a) / float(b),
    (a) => 1 / float(a),
    "Divides numbers.\nIn the case of one number, returns the multiplicative inverse (i.e. the reciprocal).",
);
export const B_mod = mathHelper(
    "mod",
    "mod",
    undefined,
    numberOp((a, b) => a % b),
    id,
    "Computes the modulo of two numbers.",
);
export const B_pow = mathHelper(
    "pow",
    "pow",
    undefined,
    numberOp((a, b) => a ** b),
    id,
    'Computes the power of numbers.\nHowever, this function still folds from the right like the other math functions, so unlike how power is notated mathematically (where `a^b^c^d^e` means `a^(b^(c^(d^e)))`), `["pow", a, b, c, d, e]` is interpreted as `(((a^b)^c)^d)^e`.',
);
export const B_bitAnd = mathHelper(
    "bitAnd",
    "bitAnd",
    undefined,
    numberOp((a, b) => a & b),
    id,
    "Computes the bitwise AND of all numbers.",
);
export const B_bitOr = mathHelper(
    "bitOr",
    "bitOr",
    undefined,
    numberOp((a, b) => a | b),
    id,
    "Computes the bitwise OR of all numbers.",
);
export const B_bitXor = mathHelper(
    "bitXor",
    "bitXor",
    undefined,
    numberOp((a, b) => a ^ b),
    id,
    "Computes the bitwise XOR of all numbers.",
);
export const B_shiftLeft = mathHelper(
    "shl",
    "shl",
    undefined,
    numberOp((a, b) => a << b),
    id,
    "Shifts `a` left by `b` bits.\nAlternatively, equivalent to `a * 2**b`.",
);
export const B_shiftRight = mathHelper(
    "shr",
    "shr",
    undefined,
    numberOp((a, b) => a >> b),
    id,
    "Shifts `a` right by `b` bits.\nAlternatively, equivalent to `floor(a / 2**b)`.",
);
export const B_bitInv = makeJSFun(
    "bitInv",
    ["a"],
    (args) => {
        const { a } = args;
        if (typeof a === "number" || typeof a === "bigint") return ~a;
        return ~withType(a, ["number", "bigint"], "a", args);
    },
    `.func (bitInv number)
..param {number} a
.pure
. Computes the two's complement signed bitwise inverse of the number.`,
);

// comparisons
const comparisonHelper = (op: string, bits: Relation, doc: string) => {
    return makeJSFun(
        op,
        ["a", "b"],
        ({ a, b }) => {
            return compareValues(a, b, bits).else((err) => {
                throw new JEBError(ErrnoCode.ENOTSUP, err);
            });
        },
        `.func (${op} items...)
..param {number | string} items...
.pure
. ${doc}`,
    );
};
const compDocHelper = (phrase: string) => `True if \`a\` is ${phrase} \`b\`.`;
export const B_eq = comparisonHelper(
    "eq",
    Relation.EQUAL,
    compDocHelper("equal to"),
);
export const B_not_eq = comparisonHelper(
    "notEq",
    Relation.NOT_EQ,
    compDocHelper("not equal to"),
);
export const B_less = comparisonHelper(
    "less",
    Relation.LESS,
    compDocHelper("less than"),
);
export const B_greater = comparisonHelper(
    "greater",
    Relation.GREATER,
    compDocHelper("greater than"),
);
export const B_less_eq = comparisonHelper(
    "lessEq",
    Relation.LESS_EQ,
    compDocHelper("not greater than"),
);
export const B_greater_eq = comparisonHelper(
    "greaterEq",
    Relation.GREATER_EQ,
    compDocHelper("not less than"),
);

const compareFn = (a: any, b: any, c: Relation): Result<boolean, string> => {
    if (a == b) return Ok(!!(c & Relation.EQUAL));
    if (a < b) return Ok(!!(c & Relation.LESS));
    if (a > b) return Ok(!!(c & Relation.GREATER));
    throw "unreachable";
};
/**
 * Compares two values against the {@link Relation} bitset `c`: numbers and
 * strings use their natural ordering; any other pair is ordered only by
 * identity (equal iff the same value), and an ordering question identity
 * cannot answer (one of less/greater, but not both) is an error.
 */
const compareValues = (
    a: any,
    b: any,
    c: Relation,
): Result<boolean, string> => {
    if (
        (isNumeric(a) && isNumeric(b)) ||
        (typeof a === "string" && typeof b === "string")
    )
        return compareFn(a, b, c);
    if (a === b) return Ok(!!(c & Relation.EQUAL));
    if (!!(c & Relation.GREATER) !== !!(c & Relation.LESS))
        return Err(
            `No ordering defined for ${theTypeName(typeOf(a))} and ${theTypeName(typeOf(b))}`,
        );
    return Ok(!!(c & Relation.LESS));
};

// MARK: booleans
export const B_not = makeJSFun(
    "not",
    ["value"],
    ({ value }) => !value,
    `.func (not value)
..param {any} value
.pure
.returns {boolean}
. True if \`value\` is falsy (false, zero, undefined, null, or empty string), false otherwise.`,
);
const booleanHelper = (name: string, shortCircuitOn: boolean) => {
    return makeJSFun(
        name,
        ["a", [true, "b"]],
        ({ a, b }, vm, location) => {
            if (!!a === shortCircuitOn) return a;
            pushData(vm, b);
            pushCommand(vm, OP_eval, location, true);
            return NOTHING;
        },
        `.macro (fn a b)
..param {any} values...
.pure
. Boolean ${name.toUpperCase()} (short-circuits).
Evaluates \`a\`, if the result is ${shortCircuitOn ? "truthy" : "falsy"}, returns it, otherwise evaluates \`b\` and returns that.`,
    );
};
export const B_and_shortcircuit = booleanHelper("and", false);
export const B_or_shortcircuit = booleanHelper("or", true);

/**
 * Registers this file's builtins in the VM's builtins scope, in the order
 * listed. Called by {@link loadBuiltins}.
 */
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
    define(vm, "shl", B_shiftLeft);
    define(vm, "shr", B_shiftRight);
    define(vm, "eq", B_eq);
    define(vm, "notEq", B_not_eq);
    define(vm, "less", B_less);
    define(vm, "greater", B_greater);
    define(vm, "lessEq", B_less_eq);
    define(vm, "greaterEq", B_greater_eq);
    define(vm, "not", B_not);
    define(vm, "and", B_and_shortcircuit);
    define(vm, "or", B_or_shortcircuit);
};

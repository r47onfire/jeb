import { isString } from "lib0/function";
import { stringify } from "lib0/json";
import { add, pow } from "lib0/math";
import { Err, Ok, Result } from "ts-res";

/**
 * thing that can be used to match a type of an object. null = wildcard, matches anything
 */
export type Type = (abstract new (...args: any[]) => any) | keyof TypeMap | null;
type TypeMap = {
    string: string;
    number: number;
    boolean: boolean;
    symbol: symbol;
    undefined: undefined;
    object: Record<PropertyKey, any>;
    function: (this: any, ...args: any) => any;
    bigint: bigint;
};

/**
 * Determines the type of the object given the type
 */
export type TypeFor<T> = T extends keyof TypeMap ? TypeMap[T] : T;

/**
 * Matches the object's type to the given specifier
 * @param obj The object to check
 * @param type The type specifier
 * @returns Score of the match, higher is a closer match, 0 is no match
 */
export function typeMatches(obj: any, type: Type): number {
    if (type === null) return 1;
    if (isString(type)) {
        return typeof obj === type ? 3 : 0;
    } else {
        return obj instanceof type ? 3 : 0;
    }
}

export const theTypeName = (type: Type) => isString(type) ? type : type?.name;
export const typeOf = (x: any): Type => { const t = typeof x; if (t === "object" && x.constructor !== Object) return x.constructor; else return t; }

// MARK: Operator overloading
/**
 * Key = operator arity (1, 2 or 3 typically)
 *
 * Value = table of [types for each operator, handler for this overload]
 */
interface OverloadTable {
    [k: number]: [types: Type[][], handler: (...params: any[]) => Result<any, string>][];
}
/**
 * Table of operations that can be done to number-like quantities
 */

export interface Operations {
    add: OverloadTable;
    sub: OverloadTable;
    div: OverloadTable;
    mul: OverloadTable;
    mod: OverloadTable;
    cmp: OverloadTable;
    pow: OverloadTable;
    bitAnd: OverloadTable;
    bitOr: OverloadTable;
    bitXor: OverloadTable;
    bitNot: OverloadTable;
}

/**
 * Name of an operation that can be done on two values.
 *
 * (in reality any string can be used; this is just so that typescript autocomplete
 * works on the commonly used ones)
 */
export type Operation = keyof Operations;
type TypeValue<T extends Type> = T extends keyof TypeMap ? TypeMap[T] : T extends abstract new (...args: any[]) => infer U ? U : T extends null ? any : never;
type TypeArrayValue<T extends Type[][]> = T extends [infer Head extends Type[], ...infer Tail extends Type[][]] ? [TypeValue<Head[number]>, ...TypeArrayValue<Tail>] : [];
// MARK: class Arithmetic

/**
 * Represents an object that you can use to perform operations on any kind of number-like quantity,
 * such as a number or vector
 */
export class Arithmetic {
    #operations: Partial<Operations> = {};
    /**
     * Defines a new overload
     * @param op Name of the operation
     * @param types List of the types that the arguments can be
     * @param handler Implementation of the operation
     */
    overload<const T extends Type[][]>(op: Operation, types: T, handler: (...args: TypeArrayValue<T>) => Result<any, string>) {
        ((this.#operations[op] ??= {})[types.length] ??= []).push([types, handler]);
    }
    /**
     * Performs an operation
     * @param op name of the operation
     * @param args Objects to operate on
     * @returns Ok if the result is successful, Err if no overload was found or the operation failed
     */
    call(op: Operation, ...args: [any, ...any[]]): Result<any, string> {
        const res = this.#findOverload(op, args);
        if (!res.ok) return res;
        return res.data(...args);
    }
    #findOverload(op: Operation, args: any[]): Result<(...args: any[]) => Result<any, string>, string> {
        const opImpl = this.#operations[op];
        if (!opImpl) return Err(`Operator ${stringify(op)} doesn't exist`);
        const opTable = opImpl[args.length];
        if (!opTable) return Err(`Operator ${stringify(op)} doesn't work with ${args.length} operands`);
        var bestScore = 0, bestHandler = undefined;
        var typeNames = args.map(_ => { }) as (string | undefined)[];
        for (var { 0: types, 1: handler } of opTable) {
            const scores = types.map((typeUnion, i) => {
                const item = args[i];
                const unionScoreRaw = typeUnion.map(type => {
                    const score = typeMatches(item, type);
                    if (score > 0) typeNames[i] ??= theTypeName(type);
                    return score;
                }).reduce(add, 0);
                return pow(unionScoreRaw, 1 / typeUnion.length);
            });
            if (scores.includes(0)) continue;
            const score = scores.reduce(add, 0);
            if (score > bestScore) {
                bestScore = score;
                bestHandler = handler;
            }
        }
        if (!bestHandler) return Err(`No overload of ${stringify(op)} found for types ${typeNames.map(t => stringify(t ?? "unknown")).join(", ")}`);
        return Ok(bestHandler);
    }
}

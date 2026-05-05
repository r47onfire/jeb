import { stringify } from "lib0/json";
import { pow } from "lib0/math";
import { Result, err, ok } from "./result";


export type Type = (abstract new (...args: any[]) => any) | keyof TypeMap | null;
type TypeMap = {
    string: string;
    number: number;
    boolean: boolean;
    symbol: symbol;
    undefined: undefined;
    object: object;
    function: Function;
    bigint: bigint;
};
export function typeMatches(obj: any, type: Type): number {
    if (type === null) return 1;
    if (typeof type === "string") {
        return typeof obj === type ? 3 : 0;
    } else {
        return obj instanceof type ? 3 : 0;
    }
}
// MARK: Operator overloading
/**
 * Key = operator arity (1 or 2)
 *
 * Value = table of [types for each operator, handler for this overload]
 */
interface OverloadTable {
    [k: number]: [types: Type[][], handler: (...params: any[]) => Result<any>][];
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

export type Operation = keyof Operations;
type TypeValue<T extends Type> = T extends keyof TypeMap ? TypeMap[T] : T extends abstract new (...args: any[]) => infer U ? U : T extends null ? any : never;
type TypeArrayValue<T extends Type[][]> = T extends [infer Head extends Type[], ...infer Tail extends Type[][]] ? [TypeValue<Head[number]>, ...TypeArrayValue<Tail>] : [];
export const add = (a: any, b: any) => a + b;
// MARK: class Arithmetic
/**
 * Represents an object that you can use to perform operations on any kind of number-like quantity,
 * such as a number or vector
 */

export class Arithmetic {
    #operations: Partial<Operations> = {};
    overload<const T extends Type[][]>(op: Operation, types: T, handler: (...args: TypeArrayValue<T>) => Result<any>) {
        ((this.#operations[op] ??= {})[types.length] ??= []).push([types, handler]);
    }
    call(op: Operation, ...args: [any, ...any[]]): Result<any> {
        const res = this.#findOverload(op, args);
        if (!res.ok) return res;
        return res.value(...args);
    }
    #findOverload(op: Operation, args: any[]): Result<(...args: any[]) => Result<any>> {
        const opImpl = this.#operations[op];
        if (!opImpl) return err(`Operator ${stringify(op)} doesn't exist`);
        const opTable = opImpl[args.length];
        if (!opTable) return err(`Operator ${stringify(op)} doesn't work with ${args.length} operands`);
        var bestScore = 0, bestHandler = undefined;
        var typeNames = args.map(_ => { }) as (string | undefined)[];
        for (var [types, handler] of opTable) {
            const scores = types.map((typeUnion, i) => {
                const item = args[i];
                const unionScoreRaw = typeUnion.map(type => {
                    const score = typeMatches(item, type);
                    if (score > 0) typeNames[i] ??= typeof type === "string" ? type : type?.name;
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
        if (!bestHandler) return err(`No overload of ${stringify(op)} found for types ${typeNames.map(t => stringify(t ?? "unknown")).join(", ")}`);
        return ok(bestHandler);
    }
}

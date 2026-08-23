import { isString } from "lib0/function";

export type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;
type _TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : _TupleOf<T, N, [T, ...R]>;

export type Writable<T> = { -readonly [P in keyof T]: T[P] };

export type Identifier = string | symbol;
export const isIdentifier = (x: unknown): x is Identifier => isString(x) || typeof x === "symbol";

export const Reflect_ownKeys = Reflect.ownKeys;

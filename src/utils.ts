import { isString } from "lib0/function";

/**
 * A tuple of exactly `N` elements of type `T` (or a plain `T[]` when `N` is
 * a general `number`).
 */
export type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;
/** Recursive builder for {@link Tuple}: prepends `T` until `R` has `N` elements. */
type _TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : _TupleOf<T, N, [T, ...R]>;

/**
 * `T` with all `readonly` modifiers removed.
 */
export type Writable<T> = { -readonly [P in keyof T]: T[P] };

/**
 * A tuple/array type with its first element removed.
 */
export type DropFirst<T extends any[]> = T extends [any, ...infer Rest] ? Rest : [];

/**
 * A variable name: either a string, or a symbol (as produced by `gensym`).
 */
export type Identifier = string | symbol;
/**
 * Type guard for {@link Identifier}.
 */
export const isIdentifier = (x: unknown): x is Identifier => isString(x) || typeof x === "symbol";

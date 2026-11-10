import { isString } from "lib0/function.js";
import { parameterError } from "./doargs";
import { ErrnoCode } from "./errno";
import { JEBError } from "./errors";
import { Identifier } from "./utils";

/** The Typescript type of the values matched by the {@link Type} specifier `T`. */
export type TypeValue<T extends Type> = T extends true
    ? any
    : T extends keyof TypeMap
      ? TypeMap[T]
      : T extends abstract new (...args: any[]) => infer U
        ? U
        : never;

/** Thing that can be used to match a type of an object. `true` = any */

export type Type =
    (abstract new (...args: any[]) => any) | keyof TypeMap | true;
/**
 * Maps the string type specifiers of {@link Type} to the Typescript types they
 * match.
 */
export type TypeMap = {
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
 * Matches the object's type to the given specifier
 *
 * @param obj The object to check
 * @param type The type specifier
 * @returns Score of the match, higher is a closer match, 0 is no match
 */

export function typeMatches(obj: any, type: Type): number {
    if (type === true) return 1;
    if (isString(type)) {
        return typeof obj === type ? 3 : 0;
    } else {
        if (!(obj instanceof type)) return 0;
        var score = 3;
        while (type) {
            score++;
            type = Object.getPrototypeOf(type);
        }
        return score;
    }
}

/** Whether a value is a real object (not null). */
export const isPlainObject = (x: unknown): x is Record<PropertyKey, any> =>
    typeof x === "object" && x !== null;

/**
 * Transforms a type predicate into something that can be used in an instanceof
 * check.
 *
 * @param predicate Type predicate that checks if an object is a particular
 *   type.
 * @returns A synthetic class that when used in an instanceof check, calls the
 *   predicate and reports that value.
 */

export const predicateToClass = <T>(
    predicate: (x: unknown) => x is T,
): abstract new (...args: unknown[]) => T => {
    return class {
        static [Symbol.hasInstance] = predicate;
    } as any;
};
/** Human-readable name of a {@link Type} specifier, for error messages. */

export const theTypeName = (type: Type) =>
    type === true ? "any" : isString(type) ? type : type.name;
/**
 * The {@link Type} specifier describing a value: its constructor, for objects
 * with a non-plain prototype, and its `typeof` string otherwise.
 */
export const typeOf = (x: any): Type => {
    const t = typeof x;
    if (t === "object" && x && x.constructor !== Object) return x.constructor;
    else return t;
};
/**
 * Asserts that `x` matches at least one of the given types, throwing a
 * {@link JEBError} (`EINVAL`) naming `paramName` if it matches none of them.
 */

export const typecheck: <T extends Type[]>(
    x: unknown,
    t: T,
    paramName?: string,
    args?: Record<Identifier, any>,
) => asserts x is TypeValue<T[number]> = (x, t, paramName, args) => {
    if (!t.some((t2) => typeMatches(x, t2))) {
        const msg = `expected ${t.map((t2) => theTypeName(t2)).join(" | ")} but got ${theTypeName(typeOf(x))}: ${x}`;
        throw paramName
            ? parameterError(args!, paramName, ErrnoCode.EINVAL, msg)
            : new JEBError(ErrnoCode.EINVAL, msg);
    }
};
/**
 * Like {@link typecheck}, but returns `x` (typed as the matched type) on
 * success.
 */
export const withType = <T extends Type[]>(
    x: unknown,
    t: T,
    paramName?: string,
    args?: Record<Identifier, any>,
): TypeValue<T[number]> => {
    typecheck(x, t, paramName, args);
    return x;
};

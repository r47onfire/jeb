import { Err, Ok, Result } from "ts-res";
import { Identifier } from "./utils";

const hasOwn = Object.hasOwn;

/**
 * Key-value store for managing an environment, with inheritance from parent environments.
 */

export class Env {
    readonly constants: Record<Identifier, true> = {};
    constructor(
        readonly bindings: Record<Identifier, any> = {},
        readonly parents: readonly Env[] = []
    ) { }
    /**
     * Look up the value, and return its value (in an ok result)
     * or an err result if not found
     */
    get(name: Identifier): Result<any, void> {
        if (hasOwn(this.bindings, name)) {
            return Ok(this.bindings[name]);
        }
        for (var i = this.parents.length - 1; i >= 0; i--) {
            const result = this.parents[i]!.get(name);
            if (result.ok) return result;
        }
        return Err();
    }
    /**
     * Defines the value in this scope (always succeeds)
     */
    add(name: Identifier, value: any) {
        this.bindings[name] = value;
    }
    /**
     * Defines the constant in this scope (always succeeds)
     */
    addConst(name: Identifier, value: any) {
        this.add(name, value);
        this.constants[name] = true;
    }
    /**
     * Finds the scope in which this value is defined, and sets it there.
     * Returns true if it was set, false if it's a constant and can't be changed,
     * or undefined if it wasn't defined anywhere.
     */
    set(name: Identifier, value: any): boolean | undefined {
        if (hasOwn(this.bindings, name)) {
            if (this.constants[name]) return false;
            this.bindings[name] = value;
            return true;
        }
        const parents = this.parents, len = parents.length;
        for (var i = 0; i < len; i++) {
            const result = parents[i]!.set(name, value);
            if (result !== undefined) return result;
        }
        return undefined;
    }
}

var n = 0;
/**
 * Returns a new unique symbol with a unique number description (to differentiate it in printouts).
 */
export const gensym = (s = "$gensym") => Symbol(s + (n++));

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
     * Returns the Env in which the given variable is defined.
     */
    scopeFor(name: Identifier): Result<Env, void> {
        if (hasOwn(this.bindings, name)) {
            return Ok(this);
        }
        const p = this.parents, len = p.length;
        for (var i = 0; i < len; i++) {
            const result = p[i]!.scopeFor(name);
            if (result.ok) return result;
        }
        return Err();
    }
    /**
     * Look up the value, and return its value (in an ok result)
     * or an err result if not found
     */
    get(name: Identifier): Result<any, void> {
        const res = this.scopeFor(name);
        if (!res.ok) return res;
        return Ok(res.data.bindings[name]);
    }
    /**
     * Defines the value in this scope (always succeeds).
     * Note: bailing on trying to reassign a constant is not checked here.
     */
    add(name: Identifier, value: any) {
        this.bindings[name] = value;
    }
    /**
     * Defines the constant in this scope (always succeeds).
     * Note: bailing on trying to reassign a constant is not checked here.
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
        const res = this.scopeFor(name);
        if (!res.ok) return undefined;
        const env = res.data;
        if (env.constants[name]) return false;
        env.bindings[name] = value;
        return true;
    }
}

var n = 0;
/**
 * Returns a new unique symbol with a unique number description (to differentiate it in printouts).
 */
export const gensym = (s = "$gensym") => Symbol(s + (n++));

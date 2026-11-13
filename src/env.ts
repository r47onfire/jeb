import { Err, Ok, Result } from "ts-res";
import { Identifier } from "./utils";

const hasOwn = Object.hasOwn;

/**
 * Key-value store for managing an environment, with inheritance from parent
 * environments.
 */

export class Env<D = any> {
    /**
     * Names defined as constants in this scope; {@link set} refuses to change
     * them
     */
    readonly constants: Record<Identifier, true> = {};
    constructor(
        /** The bindings defined directly in this scope */
        readonly bindings: Record<Identifier, D> = {},
        /** Parent environments searched after this one, in order */
        readonly parents: readonly Env<D>[] = [],
    ) {}
    /** Returns the Env in which the given variable is defined. */
    scopeFor(name: Identifier): Result<Env<D>, void> {
        if (hasOwn(this.bindings, name)) {
            return Ok(this);
        }
        const p = this.parents,
            len = p.length;
        for (let i = 0; i < len; i++) {
            const result = p[i]!.scopeFor(name);
            if (result.ok) return result;
        }
        return Err();
    }
    /**
     * Look up the value, and return its value (in an ok result) or an err
     * result if not found
     */
    get(name: Identifier): Result<D, void> {
        const res = this.scopeFor(name);
        if (!res.ok) return res as Result<never, void>;
        return Ok(res.data.bindings[name] as D);
    }
    /**
     * Defines the value in this scope (always succeeds). Note: bailing on
     * trying to reassign a constant is not checked here.
     */
    add(name: Identifier, value: D) {
        this.bindings[name] = value;
    }
    /**
     * Defines the constant in this scope (always succeeds). Note: bailing on
     * trying to reassign a constant is not checked here.
     */
    addConst(name: Identifier, value: D) {
        this.add(name, value);
        this.constants[name] = true;
    }
    /**
     * Finds the scope in which this value is defined, and sets it there.
     * Returns the env it was just set in if it was set, false if it's a
     * constant and can't be changed, or undefined if it wasn't defined
     * anywhere.
     */
    set(name: Identifier, value: D): Env<D> | false | undefined {
        const res = this.scopeFor(name);
        if (!res.ok) return undefined;
        const env = res.data;
        if (env.constants[name]) return false;
        env.bindings[name] = value;
        return env;
    }
}

let n = 0;
/**
 * Returns a new unique symbol with a unique number description (to
 * differentiate it in printouts). It really returns a symbol, but since symbols
 * can masquerade as strings in Javascript object properties, it still works.
 */
export const gensym = (s = "_") => Symbol(s + n++) as any as string;

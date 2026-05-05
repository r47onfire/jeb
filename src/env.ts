import { keys } from "lib0/object";
import { Result, err, ok } from "./result";

const hasOwn = Object.hasOwn;

/**
 * Key-value store for managing an environment, with inheritance from parent environments.
 */

export class Env {
    constructor(
        readonly bindings: Record<string, any> = {},
        readonly parents: readonly Env[] = []
    ) { }
    /**
     * Look up the value, and return its value (in an ok result)
     * or an err result if not found
     */
    get(name: string): Result<any> {
        if (hasOwn(this.bindings, name)) {
            return ok(this.bindings[name]);
        }
        for (var i = 0; i < this.parents.length; i++) {
            const result = this.parents[i]!.get(name);
            if (result.ok) return result;
        }
        return err("");
    }
    /**
     * Defines the value in this scope
     */
    define(name: string, value: any) {
        this.bindings[name] = value;
    }
    /**
     * Finds the scope in which this value is defined, and sets it there.
     * Returns true if it was set, or false if it wasn't found.
     */
    set(name: string, value: any) {
        if (hasOwn(this.bindings, name)) {
            this.bindings[name] = value;
            return true;
        }
        for (var i = 0; i < this.parents.length; i++) {
            if (this.parents[i]!.set(name, value)) return true;
        }
        return false;
    }
    /**
     * Generates a random symbol that isn't set anywhere already.
     */
    gensym() {
        for (; ;) {
            const name = `_${randchars()}`;
            if (!this.get(name).ok) return name;
        }
    }
    getVisibleNames(): string[] {
        return keys(this.bindings).concat(...this.parents.map(p => p.getVisibleNames()));
    }
}

function randchars() {
    return Math.random().toString(36).slice(2, 10);
}

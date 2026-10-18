import type { JebVM } from "./vm";

/**
 * Callbacks to run once per new {@link JebVM}, after the builtins are loaded.
 * Modules register theirs with {@link __initializer} to install extra
 * protocols and unwrappers without the VM constructor knowing about them.
 */
export const __initializers: ((x: JebVM) => void)[] = [];
/**
 * Registers a callback to be run for every VM created from now on
 * (see {@link __initializers}).
 */
export const __initializer = (f: (x: JebVM) => void) => {
    __initializers.push(f);
}

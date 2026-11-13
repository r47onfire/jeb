import { parseSignature, Signature } from "./signature";
import { Identifier } from "./utils";
import { SCHEDULED, type JebVM } from "./vm";
import type { JSONCode } from "./evaluate";

/**
 * A host-language function callable from JEB code. The values it is called with
 * have already been bound against its signature by `bindArgs` (see
 * {@link JSFun}): argument counts checked, lazy parameters holding their raw
 * forms, defaults filled in, and rest arguments bundled into a single array
 * argument. It returns the call's result, or {@link SCHEDULED} when it arranged
 * the result itself by scheduling commands.
 */
export type HostFunction<D = any> = (
    vm: JebVM<D, any>,
    ...args: D[]
) => D | typeof SCHEDULED;

/**
 * A {@link HostFunction} bundled with the name and signature it is called
 * through. A bare host function is never callable from code -- only a JSFun is
 * -- because the signature is what tells the dispatcher how to check and
 * prepare the arguments.
 */
export class JSFun<D = any> {
    readonly signature: Signature;
    constructor(
        readonly name: Identifier,
        params: JSONCode,
        readonly fn: HostFunction<D>,
        vm: JebVM<D, any>,
    ) {
        this.signature = parseSignature(vm, params);
    }
}

/**
 * Creates a {@link JSFun} from a parameter list form (the same forms a `lambda`
 * takes; see {@link parseSignature}) and a host function.
 */
export const makeJSFun = <D>(
    vm: JebVM<D, any>,
    name: Identifier,
    params: JSONCode,
    fn: HostFunction<D>,
): JSFun<D> => new JSFun(name, params, fn, vm);

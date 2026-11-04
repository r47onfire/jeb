import { Block } from "../block";
import { defineAccessor, defineApplier } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { AccessReference, protocolMethod } from "../protocol";
import { PROTOCOL_SYMBOLS, ProtocolSymbolName } from "../well_known";
import { ApplyMetadata } from "../protocol";
import { predicateToClass, theTypeName, typeOf } from "../typecheck";
import { JebVM } from "../vm";
import { Wrapper } from "../wrapper";
import { bindMethod, pushMethodApply } from "./eval";

/**
 * Fallback protocol implementations for plain objects that provide their own
 * protocol methods: functions stored on the object under the protocols' symbols
 * (see {@link PROTOCOL_SYMBOLS}). These are what let code written in JEB itself
 * overload calls, indexing, naming, and unwrapping, and (through the operator
 * builtins) the math operations, instead of only host code being able to
 * register protocol implementations.
 *
 * Each fallback is registered for a pseudoclass matching exactly the values
 * that provide that protocol's method, so a fallback is only ever selected when
 * the method exists -- the handlers never check for it themselves, they just
 * call it and let whatever errors fall out of the call.
 */

/**
 * Whether a value is a plain object (or array): the values that can carry
 * protocol methods. Host class instances (functions, environments, blocks, ...)
 * never match, so these fallbacks can't shadow their dedicated protocol
 * implementations.
 */
const isPlainObject = (x: unknown): x is Record<PropertyKey, any> =>
    typeof x === "object" &&
    x !== null &&
    (Array.isArray(x) ||
        Object.getPrototypeOf(x) === Object.prototype ||
        Object.getPrototypeOf(x) === null);

/**
 * Pseudoclass matching the plain objects that provide the named protocol
 * method.
 */
const hasMethod = (name: ProtocolSymbolName) =>
    predicateToClass(
        (x): x is Record<PropertyKey, any> =>
            isPlainObject(x) && x[PROTOCOL_SYMBOLS[name]] !== undefined,
    );

/**
 * Pseudoclass matching the plain objects that provide any descriptor protocol
 * method (`__access__`, `__get__`, or `__set__`).
 */
const HasDescriptorMethods = predicateToClass(
    (x): x is Record<PropertyKey, any> =>
        isPlainObject(x) &&
        (x[PROTOCOL_SYMBOLS.access] !== undefined ||
            x[PROTOCOL_SYMBOLS.get] !== undefined ||
            x[PROTOCOL_SYMBOLS.set] !== undefined),
);

/**
 * Pseudoclass matching the wrappers that provide a `__unwrap__` method.
 * (Wrappers are VM machinery and don't go through {@link protocolMethod}, so
 * the symbol is read directly.)
 */
const HasUnwrapMethod = predicateToClass(
    (x): x is Wrapper =>
        x instanceof Wrapper &&
        (x as any)[PROTOCOL_SYMBOLS.unwrap] !== undefined,
);

/**
 * Metadata of a protocol method: its signature, name, and closure environment,
 * from the `apply` protocol. If the value stored as the method can't be called
 * at all, looking up its applier throws.
 */
const methodMetadata = (vm: JebVM, method: any): ApplyMetadata =>
    vm.getProtocol(true, true, "apply", [method]).describe(vm, method);

/**
 * Any plain object with a `__call__` method is callable: the method is applied
 * with the object bound to its first parameter (see {@link bindMethod}),
 * followed by the call's own arguments. The signature the call is checked
 * against is the method's signature without that first (receiver) parameter, so
 * the method's lazy and quoted parameters keep their usual meaning -- in
 * particular a method whose parameters are all lazy (like the null-chaining
 * sentinel's) is called without any of its arguments being evaluated.
 */
const loadMethodApplier = (vm: JebVM) =>
    defineApplier(
        vm,
        [hasMethod("apply")],
        (vm, { 0: obj }, { tail, location }) => {
            const bound = bindMethod(obj, protocolMethod(obj, "apply")!);
            vm.getProtocol(true, true, "apply", [bound]).run(vm, [bound], {
                tail,
                location,
            });
        },
        (vm, obj) =>
            methodMetadata(vm, bindMethod(obj, protocolMethod(obj, "apply")!)),
        "An object with a __call__ protocol method is callable through that method, with the object as the method's first argument.",
    );

/**
 * Indexing a plain object that provides descriptor protocol methods goes
 * through its `__access__` method only: the result is an
 * {@link AccessReference} (the key has already been evaluated on this path, so
 * it is quoted -- the access step receives it as the value it is). An object
 * with `__get__`/`__set__` methods but no `__access__` is a descriptor, not
 * indexable, and indexing it is an error. Objects without descriptor methods
 * keep the default accessor.
 */
const loadDescriptorAccessor = (vm: JebVM) =>
    defineAccessor(
        vm,
        [HasDescriptorMethods],
        (vm, { 0: obj }, { field, type }) => {
            if (!protocolMethod(obj, "access"))
                throw new JEBError(
                    ErrnoCode.EINVAL,
                    `${theTypeName(typeOf(obj))} is not subscriptable`,
                );
            return new AccessReference(
                type,
                obj,
                new Block(vm.currentEnv, [["quote", field]]),
            );
        },
        "Accessor for plain objects with descriptor protocol methods: indexing goes through the object's __access__ method, and an object with only __get__/__set__ methods is not subscriptable.",
    );

/**
 * When a value with a `__name__` method is assigned to a variable, the method
 * is called with the value and the name.
 */
const loadNameMethod = (vm: JebVM) =>
    vm.addProtocol("name", {
        type: [[hasMethod("name")]],
        run(vm, { 0: value }, { name }) {
            pushMethodApply(
                vm,
                protocolMethod(value, "name")!,
                [value, name],
                true,
            );
        },
        doc: "Calls the value's __name__ protocol method with the name it was assigned to.",
    });

/**
 * A wrapper class with no dedicated unwrapper can still be unwrapped if
 * instances provide a `__unwrap__` method: unwrapping calls it and uses its
 * result.
 */
const loadUnwrapMethod = (vm: JebVM) =>
    vm.addProtocol("unwrap", {
        type: [[HasUnwrapMethod]],
        run(vm, { 0: wrapper }) {
            pushMethodApply(vm, (wrapper as any)[PROTOCOL_SYMBOLS.unwrap], [
                wrapper,
            ]);
        },
        doc: "Unwraps a wrapper by calling its __unwrap__ protocol method.",
    });

/**
 * Registers the object protocol-method fallbacks in the VM. The fallbacks only
 * match values that provide the relevant method (see the pseudoclasses above),
 * so they compose with the dedicated protocol implementations in any
 * registration order.
 */
export const loadProtocolMethods = (vm: JebVM) => {
    loadMethodApplier(vm);
    loadDescriptorAccessor(vm);
    loadNameMethod(vm);
    loadUnwrapMethod(vm);
};

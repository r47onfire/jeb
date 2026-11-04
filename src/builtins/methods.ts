import {
    defineApplier,
    defineGetter,
    defineSetter,
    defineUnwrapper,
    NOTHING,
} from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { AccessReference, protocolMethod, Reference } from "../protocol";
import { PROTOCOL_SYMBOLS, ProtocolSymbolName } from "../well_known";
import { ApplyMetadata } from "../protocol";
import { predicateToClass, theTypeName, typeOf } from "../typecheck";
import { JebVM, pushCommand } from "../vm";
import { Wrapper } from "../wrapper";
import {
    curry,
    OP_accessed_get,
    OP_accessed_set,
    pushAccessCall,
    pushMethodApply,
} from "./eval";
import { OP_unwrap } from "./unwrap";

/**
 * Fallback protocol implementations for plain objects that provide their own
 * protocol methods: functions stored on the object under the protocols' symbols
 * (see {@link PROTOCOL_SYMBOLS}). These are what let code written in JEB itself
 * overload calls, indexing, naming, unwrapping, and reading and assignment, and
 * (through the operator builtins) the math operations, instead of only host
 * code being able to register protocol implementations. The `get` / `set`
 * implementations for references and access references also live here.
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
 * Pseudoclass that claims plain objects that provide the named protocol method
 * (although its callability is not checked).
 *
 * @example
 *     const Callable = hasMethod("apply");
 *     console.log({ [PROTOCOL_SYMBOLS.apply]: true } instanceof Callable); // true
 *
 * @see {@link PROTOCOL_SYMBOLS}
 */
const hasMethod = <
    T extends Record<PropertyKey, any> = Record<PropertyKey, any>,
>(
    name: ProtocolSymbolName,
) =>
    predicateToClass(
        (x): x is T =>
            isPlainObject(x) && x[PROTOCOL_SYMBOLS[name]] !== undefined,
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
 * with the object bound to its first parameter (see {@link curry}), followed by
 * the call's own arguments. The signature the call is checked against is the
 * method's signature without that first (receiver) parameter, so the method's
 * lazy and quoted parameters keep their usual meaning -- in particular a method
 * whose parameters are all lazy (like the null-chaining sentinel's) is called
 * without any of its arguments being evaluated.
 */
const loadMethodApplier = (vm: JebVM) =>
    defineApplier(
        vm,
        [hasMethod("apply")],
        (vm, { 0: obj }, { tail, location }) => {
            const bound = curry(vm, protocolMethod(obj, "apply")!, obj);
            vm.getProtocol(true, true, "apply", [bound]).run(vm, [bound], {
                tail,
                location,
            });
        },
        (vm, obj) =>
            methodMetadata(vm, curry(vm, protocolMethod(obj, "apply")!, obj)),
        "An object with a __call__ protocol method is callable through that method, with the object as the method's first argument.",
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
 * Pseudoclass matching the values that provide a `__unwrap__` method: a
 * value with a `__tag__` and no dedicated unwrapper is unwrapped by
 * calling the method and using its result. (Unlike the other method
 * fallbacks this one also matches host class instances: saying a tag is
 * not limited to plain objects. `OP_unwrap` only dispatches here after
 * the value's tag has passed its flag lists, and references are read and
 * assigned, never unwrapped, so they are excluded.)
 */
const HasUnwrapMethod = predicateToClass(
    (x): x is Record<PropertyKey, any> =>
        typeof x === "object" &&
        x !== null &&
        !(x instanceof Reference) &&
        (x as any)[PROTOCOL_SYMBOLS.unwrap] !== undefined,
);

const loadUnwrapMethod = (vm: JebVM) =>
    defineUnwrapper(
        vm,
        // The pseudoclass matches any value carrying the method, not
        // just Wrapper subclasses, so it does not fit defineUnwrapper's
        // Wrapper-typed signature.
        [HasUnwrapMethod] as any,
        (vm, { 0: wrapper }) => {
            pushMethodApply(vm, (wrapper as any)[PROTOCOL_SYMBOLS.unwrap], [
                wrapper,
            ]);
        },
        "Unwraps a wrapper by calling its __unwrap__ protocol method.",
    );

/**
 * Reading a reference goes through its `get()`; assigning to one goes through
 * its `set()`, with the assignment flags.
 */
const loadReferenceGetSet = (vm: JebVM) => {
    defineGetter(
        vm,
        [Reference],
        (vm, { 0: ref }, { shouldBind }) => ref.get(vm, shouldBind),
        "Reads a reference by calling its get() method.",
    );
    defineSetter(
        vm,
        [Reference],
        (vm, { 0: ref, 1: value }, { create, readonly }) => {
            ref.set(vm, value, create, readonly);
        },
        "Assigns to a reference by calling its set() method.",
    );
};

/**
 * A descriptor (an object with `__get__` / `__set__` methods) is read and
 * assigned through those methods, which receive the descriptor itself. (The
 * assignment flags only apply to references, so the `__set__` implementation
 * doesn't see them.)
 */
const loadMethodGetSet = (vm: JebVM) => {
    defineGetter(
        vm,
        [hasMethod("get")],
        (vm, { 0: obj }) => {
            pushCommand(vm, OP_unwrap, []);
            pushMethodApply(vm, protocolMethod(obj, "get")!, [obj]);
            return NOTHING;
        },
        "Reads a descriptor by calling its __get__ protocol method.",
    );
    defineSetter(
        vm,
        [hasMethod("set")],
        (vm, { 0: obj, 1: value }) => {
            pushMethodApply(
                vm,
                protocolMethod(obj, "set")!,
                [obj, value],
                true,
            );
        },
        "Assigns to a descriptor by calling its __set__ protocol method.",
    );
};

/**
 * An {@link AccessReference} reads and assigns through the descriptor its
 * object's `__access__` method returns: the handlers schedule the access call
 * and then read or assign through the returned descriptor. (Registered last of
 * the `get` / `set` implementations: an access reference is also a
 * {@link Reference}, and its own implementation must win over the reference
 * one.)
 */
const loadAccessReferenceGetSet = (vm: JebVM) => {
    defineGetter(
        vm,
        [AccessReference],
        (vm, { 0: ref }) => {
            pushCommand(vm, OP_accessed_get, ref.propertyName);
            pushCommand(vm, OP_unwrap, []);
            pushAccessCall(vm, ref);
            return NOTHING;
        },
        "Reads an access reference through the descriptor its object's __access__ method returns.",
    );
    defineSetter(
        vm,
        [AccessReference],
        (vm, { 0: ref }) => {
            pushCommand(vm, OP_accessed_set, ref.propertyName);
            pushCommand(vm, OP_unwrap, []);
            pushAccessCall(vm, ref);
        },
        "Assigns an access reference through the descriptor its object's __access__ method returns.",
    );
};

export const loadProtocolMethods = (vm: JebVM) => {
    loadMethodApplier(vm);
    loadNameMethod(vm);
    loadUnwrapMethod(vm);
    loadReferenceGetSet(vm);
    loadMethodGetSet(vm);
    loadAccessReferenceGetSet(vm);
};

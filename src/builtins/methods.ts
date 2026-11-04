import { Block } from "../block";
import {
    defineApplier,
    defineGetter,
    defineSetter,
    makeOpcode,
    NOTHING,
} from "../define";
import { Laziness } from "../signature";
import {
    AccessReference,
    ApplyMetadata,
    protocolMethod,
    Reference,
    Unwrappable,
} from "../protocol";
import { isPlainObject, predicateToClass } from "../typecheck";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { PROTOCOL_SYMBOLS, ProtocolSymbolName } from "../well_known";
import {
    accessedSetter,
    curry,
    OP_accessed_get,
    OP_accessed_set,
    OP_apply,
    OP_shuffle,
    pushAccessCall,
    pushMethodApply,
} from "./eval";
import { OP_assign_internal, OP_push_value } from "./variables";
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
            isPlainObject(x) && Reflect.has(x, PROTOCOL_SYMBOLS[name]),
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
 * A value that is a wrapper by providing the wrapper properties
 * ({@link Unwrappable}) is unwrapped by calling its `__unwrap__` method and
 * using the result; its tag, for the `unwrap` protocol's describe, is its
 * `__tag__` property.
 */
const loadUnwrapMethod = (vm: JebVM) =>
    vm.addProtocol("unwrap", {
        // The pseudoclass matches any value carrying the properties,
        // not just Wrapper subclasses, so it does not fit the unwrap
        // protocol's Wrapper-typed signature.
        type: [[Unwrappable]] as any,
        run: (vm, { 0: wrapper }) => {
            pushMethodApply(vm, (wrapper as any)[PROTOCOL_SYMBOLS.unwrap], [
                wrapper,
            ]);
        },
        describe: (vm, wrapper) => (wrapper as any)[PROTOCOL_SYMBOLS.tag],
        doc: "Unwraps a wrapper by calling its __unwrap__ protocol method.",
    });

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
        (vm, { 0: ref, 1: value }, { create, readonly, unevaluated, old }) => {
            if (unevaluated) {
                pushCommand(
                    vm,
                    OP_assign_internal,
                    value as Block,
                    old ?? false,
                );
                pushData(vm, ref);
                return;
            }
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
        (vm, { 0: obj, 1: value }, { unevaluated, old }) => {
            const set = protocolMethod(obj, "set")!;
            if (!unevaluated) {
                pushMethodApply(vm, set, [obj, value], true);
                return;
            }
            // The value is still an unevaluated block: the method's
            // signature decides whether it is evaluated. A lazy value
            // parameter takes the expression verbatim (through OP_apply,
            // so the signature does the binding) and the assignment
            // returns the method's own result -- or the old value, read
            // through __get__ first, if that was requested. Otherwise
            // the shared dance evaluates it, with `_` bound to the old
            // value, and this implementation is re-entered with the
            // computed value.
            const { signature } = vm
                .getProtocol(true, true, "apply", [set])
                .describe(vm, set);
            const valueParam = signature[1];
            if (valueParam && valueParam.lazy !== Laziness.NONE) {
                if (old) pushCommand(vm, OP_shuffle, 1, []); // the __set__ result is dropped
                pushData(vm, set);
                pushCommand(
                    vm,
                    OP_apply,
                    [obj, (value as Block).body[0]],
                    undefined,
                    false,
                    [true, false],
                );
                if (old) {
                    const get = protocolMethod(obj, "get");
                    if (get) {
                        pushCommand(vm, OP_unwrap, []);
                        pushMethodApply(vm, get, [obj]);
                    } else pushCommand(vm, OP_push_value, undefined);
                }
                return;
            }
            pushCommand(vm, OP_assign_internal, value as Block, old ?? false);
            pushData(vm, obj);
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
        (vm, { 0: ref, 1: value }, { unevaluated, old }) => {
            if (unevaluated) {
                pushCommand(
                    vm,
                    OP_assign_accessed,
                    value as Block,
                    old ?? false,
                    ref.propertyName,
                );
                pushCommand(vm, OP_unwrap, []);
                pushAccessCall(vm, ref);
                return;
            }
            pushCommand(vm, OP_accessed_set, ref.propertyName);
            pushCommand(vm, OP_unwrap, []);
            pushAccessCall(vm, ref);
        },
        "Assigns an access reference through the descriptor its object's __access__ method returns.",
    );
};

/**
 * Continuation of an unevaluated assignment through an {@link
 * AccessReference}:
 * the descriptor object returned by `__access__` is on top of the data stack;
 * the assignment re-dispatches the `set` protocol on it, still with the
 * unevaluated value, so the descriptor's own implementation decides how the
 * value is handled. (The opcode flavor uses `OP_accessed_set` instead: its
 * value is already computed.)
 */
const OP_assign_accessed = makeOpcode(
    null,
    (
        vm: JebVM,
        {
            0: value,
            1: wantOld,
            2: property,
        }: [Block, boolean, string | undefined],
    ) => {
        const descriptor = popData(vm);
        accessedSetter(descriptor, property);
        vm.getProtocol(true, false, "set", [descriptor, value])!.run(
            vm,
            [descriptor, value],
            { create: false, readonly: false, unevaluated: true, old: wantOld },
        );
    },
    null,
);

export const loadProtocolMethods = (vm: JebVM) => {
    loadMethodApplier(vm);
    loadNameMethod(vm);
    loadUnwrapMethod(vm);
    loadReferenceGetSet(vm);
    loadMethodGetSet(vm);
    loadAccessReferenceGetSet(vm);
};

import { Fun, JSFun } from "../callable";
import { defineAccessor, defineApplier, makeOpcode } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import {
    DescriptorReference,
    PROTOCOL_SYMBOLS,
    protocolMethod,
} from "../protocol";
import { ApplyMetadata } from "../protocol";
import { predicateToClass, theTypeName, typeOf } from "../typecheck";
import { Identifier } from "../utils";
import { JebVM, popData, pushCommand, pushData } from "../vm";
import { Wrapper } from "../wrapper";
import { pushMethodCall } from "./eval";
import { ObjectPropertyReference } from "./reference";

/**
 * Fallback protocol implementations for plain objects that provide their
 * own protocol methods: functions stored on the object under the protocols'
 * symbols (see {@link PROTOCOL_SYMBOLS}). These are what let code written in
 * JEB itself overload calls, indexing, naming, unwrapping, and (through the
 * operator builtins) the math operations, instead of only host code being
 * able to register protocol implementations.
 */

/**
 * Matches only plain objects (and arrays): the values that can carry
 * protocol methods. Host class instances (functions, environments, blocks,
 * ...) never match, so these fallbacks can't shadow their dedicated
 * protocol implementations.
 */
const PlainObject = predicateToClass(
    (x): x is Record<PropertyKey, any> =>
        typeof x === "object" &&
        x !== null &&
        (Array.isArray(x) ||
            Object.getPrototypeOf(x) === Object.prototype ||
            Object.getPrototypeOf(x) === null),
);

/**
 * Metadata of a protocol method, which must be an ordinary callable (a
 * {@link Fun} or a {@link JSFun}); other callables (blocks, continuations)
 * can't take a receiver and are rejected.
 */
const methodMetadata = (vm: JebVM, method: any): ApplyMetadata => {
    if (!(method instanceof Fun) && !(method instanceof JSFun))
        throw new JEBError(
            ErrnoCode.EINVAL,
            `${theTypeName(typeOf(method))} can't be used as a protocol method`,
        );
    return vm.getProtocol(true, true, "apply", [method]).describe(vm, method);
};

/** Binds the receiver to the first parameter of a method call's bound arguments. */
const OP_insert_self = makeOpcode(
    null,
    (
        vm: JebVM,
        { 0: self, 1: firstParam }: [any, Identifier | undefined],
    ) => {
        const argsObj = popData(vm);
        if (firstParam !== undefined) argsObj[firstParam] = self;
        pushData(vm, argsObj);
    },
    null,
);

/**
 * Any plain object with a `__call__` method is callable: the method is
 * called with the object as its first argument, followed by the call's own
 * arguments. The signature the call is checked against is the method's
 * signature without that first (receiver) parameter, so the method's lazy
 * and quoted parameters keep their usual meaning -- in particular a method
 * whose parameters are all lazy (like the null-chaining sentinel's) is
 * called without any of its arguments being evaluated.
 */
const loadMethodApplier = (vm: JebVM) =>
    defineApplier(
        vm,
        [PlainObject],
        (vm, { 0: obj }, { tail, location }) => {
            const method = protocolMethod(obj, "apply")!;
            const { signature } = methodMetadata(vm, method);
            vm.getProtocol(true, true, "apply", [method]).run(vm, [method], {
                tail,
                location,
            });
            pushCommand(vm, OP_insert_self, obj, signature[0]?.name);
        },
        (vm, obj) => {
            const method = protocolMethod(obj, "apply");
            if (!method)
                throw new JEBError(
                    ErrnoCode.EINVAL,
                    `can't call ${theTypeName(typeOf(obj))}`,
                    {},
                    { return: vm.cc() },
                );
            const { name, signature, closureEnv } = methodMetadata(
                vm,
                method,
            );
            if (signature[0]?.rest)
                throw new JEBError(
                    ErrnoCode.EINVAL,
                    "a __call__ method's first parameter (the receiver) can't be a rest parameter",
                );
            return { name, signature: signature.slice(1), closureEnv };
        },
        "An object with a __call__ protocol method is callable through that method, with the object as the method's first argument.",
    );

/**
 * Indexing a plain object goes through its `__get__`/`__set__` methods if
 * it provides them (the object is a descriptor for its fields); otherwise
 * the field is a plain Javascript property, as before. Because this
 * accessor is registered after the default object accessor and matches it
 * in specificity, it wins for plain objects and delegates to exactly the
 * default behavior for non-descriptors.
 */
const loadDescriptorAccessor = (vm: JebVM) =>
    defineAccessor(
        vm,
        [PlainObject],
        (_, { 0: obj }, { field, type }) =>
            protocolMethod(obj, "get") ?? protocolMethod(obj, "set")
                ? new DescriptorReference(type, obj, field)
                : new ObjectPropertyReference(type, obj, field),
        "Accessor for plain objects: objects with __get__/__set__ protocol methods are indexed through those methods, other objects' properties are read and written directly.",
    );

/**
 * When a value with a `__name__` method is assigned to a variable, the
 * method is called with the value and the name (the host `name` protocol
 * for functions, which renames them, is registered after this and so wins
 * for functions).
 */
const loadNameMethod = (vm: JebVM) =>
    vm.addProtocol("name", {
        type: [[PlainObject]],
        run(vm, { 0: value }, { name }) {
            const method = protocolMethod(value, "name");
            if (method) pushMethodCall(vm, method, [value, name], true);
        },
        doc: "Calls the value's __name__ protocol method with the name it was assigned to.",
    });

/**
 * A wrapper class with no dedicated unwrapper can still be unwrapped if
 * instances provide a `__unwrap__` method: unwrapping calls it and uses
 * its result. (Wrappers are VM machinery and don't go through
 * {@link protocolMethod}, so the symbol is read directly.)
 */
const loadUnwrapMethod = (vm: JebVM) =>
    vm.addProtocol("unwrap", {
        type: [[Wrapper]],
        run(vm, { 0: wrapper }) {
            const method = (wrapper as any)[PROTOCOL_SYMBOLS.unwrap];
            if (
                !(method instanceof Fun) &&
                !(method instanceof JSFun) &&
                typeof method !== "function"
            )
                throw new JEBError(
                    ErrnoCode.ERANGE,
                    `No overload of unwrap exists for type ${theTypeName(typeOf(wrapper))}`,
                );
            pushMethodCall(vm, method, [wrapper]);
        },
        doc: "Unwraps a wrapper by calling its __unwrap__ protocol method.",
    });

/**
 * Registers the object protocol-method fallbacks in the VM. The fallbacks
 * only match plain objects (see {@link PlainObject}), so they compose with
 * the dedicated protocol implementations in any registration order; the one
 * exception is the descriptor accessor, which is registered after the
 * default object accessor so that it wins for plain objects and delegates
 * to exactly the default behavior for non-descriptors.
 */
export const loadProtocolMethods = (vm: JebVM) => {
    loadMethodApplier(vm);
    loadDescriptorAccessor(vm);
    loadNameMethod(vm);
    loadUnwrapMethod(vm);
};

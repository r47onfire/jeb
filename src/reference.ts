import { Env } from "./env";
import { Location } from "./errors";
import { CallableSignature } from "./signature";
import { Identifier } from "./utils";
import type { JebVM } from "./vm";

/**
 * Core contracts of the runtime that are not tied to any one builtin file:
 * the reference model (slots that can be read and assigned), the metadata
 * every callable is described by, and the flag objects the central opcodes
 * (`eval`, `apply`, `index`, `get`, `assign`) pass to the code they dispatch
 * to.
 */

/** The capacity in which a {@link Reference} is accessed. */
export const enum AccessType {
    VARIABLE,
    FUNCTION,
    PROPERTY,
}

/** Represents a slot that can be assigned to */
export abstract class Reference {
    constructor(readonly type: AccessType) {}
    /**
     * Returns the current value, or returns `NOTHING` and throws an error (in
     * the VM, not Javascript) if it's not readable.
     */
    abstract get(vm: JebVM, shouldBind: boolean): any;
    /**
     * Set the value of the slot to the provided value, or throws an error if
     * it's readonly. The stack should not be modified either way.
     */
    abstract set(
        vm: JebVM,
        value: any,
        createIfNotFound: boolean,
        makeConstant: boolean,
    ): void;
}

/**
 * Metadata describing a callable: everything the `apply` opcode needs to set
 * up the call besides the callee itself.
 */
export interface ApplyMetadata {
    /**
     * The name of the function to appear in tracebacks, if undefined it means
     * it's a hidden callframe and won't show.
     */
    name: Identifier | undefined;
    /** The callable's parameter signature, used to process its arguments. */
    signature: CallableSignature;
    /**
     * The environment(s) that this function closes over on order to allow
     * default value expressions to be evaluated in that environment.
     */
    closureEnv?: Env;
}

/** Flags for a single call, handed to a callable's apply implementation. */
export interface ApplyFlags {
    /** Whether the call is in tail position. */
    tail: boolean;
    /** Source location of the call site, for tracebacks. */
    location: Location | undefined;
}

/** Flags for a single evaluation, handed to an evaluation implementation. */
export interface EvalFlags {
    /** Whether the evaluation is in tail position. */
    tail: boolean;
    /** Source location of the expression being evaluated, for tracebacks. */
    location: Location | undefined;
}

/** Flags for a single indexing operation: which field, in what capacity. */
export interface AccessFlags {
    /** The field (variable name, property key, ...) being accessed. */
    field: PropertyKey;
    /** The capacity in which the field is accessed. */
    type: AccessType;
}

/** Flags for a single read of a reference. */
export interface GetFlags {
    /** Whether a lazy binding is bound (evaluated) by the read. */
    shouldBind: boolean;
}

/** Flags for a single assignment to a reference. */
export interface SetFlags {
    /** Whether the slot is created if it doesn't exist yet. */
    create: boolean;
    /** Whether the slot becomes read-only. */
    readonly: boolean;
    /**
     * The value argument is an unevaluated `Block` (the `assign` builtin's
     * right-hand side): the assignment arranges its evaluation, with `_`
     * bound to the old value, unless the assignment target's own signature
     * takes it unevaluated. Absent for the `assign` opcode, whose value is
     * already computed.
     */
    unevaluated?: boolean;
    /** With `unevaluated`: the assignment's result is the old value. */
    old?: boolean;
}

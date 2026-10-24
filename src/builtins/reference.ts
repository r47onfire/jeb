import { stringify } from "lib0/json";
import { OP_apply, OP_shuffle } from ".";
import { Fun } from "../callable";
import { Env } from "../env";
import { ErrnoCode } from "../errno";
import { JEBError, wrapThrowToError } from "../errors";
import { AccessType, Reference } from "../protocol";
import { Identifier } from "../utils";
import { JebVM, pushCommand, pushData } from "../vm";

/**
 * A reference to a property of a plain JavaScript object (host-language
 * interop). Reads and writes also emit audit events, since they reach
 * outside the JEB runtime.
 */
export class ObjectPropertyReference extends Reference {
    constructor(type: AccessType, readonly obj: any, readonly name: PropertyKey) { super(type); }
    /**
     * Reads the property. If `shouldBind` is set and the value is a function,
     * it is bound to the object, so host methods keep their receiver.
     */
    get(vm: JebVM, shouldBind: boolean) {
        vm.emit("jeb:ffi/object/get", [this.name, this.obj]);
        var value = this.obj[this.name];
        if (shouldBind && typeof value === "function") value = value.bind(this.obj);
        return value;
    }
    /**
     * Writes the property, converting any JavaScript exception thrown by a
     * setter into a JEB error.
     */
    set(vm: JebVM, value: any) {
        vm.emit("jeb:ffi/object/set", [this.name, this.obj, value]);
        wrapThrowToError(ErrnoCode.EJAVASCRIPT, () => {
            this.obj[this.name] = value;
        });
    }
}

/**
 * A reference to a variable in an {@link Env}. The access type decides both
 * how the reference behaves and the wording of the error reported when the
 * variable does not exist (variable, function call target, or module
 * property).
 */
export class VariableReference extends Reference {
    /** Message of the error thrown when the variable cannot be found */
    readonly notFoundMessage: string;
    constructor(type: AccessType, readonly env: Env, readonly name: Identifier) {
        super(type);
        this.notFoundMessage = type === AccessType.PROPERTY ? `module has no property ${stringify(this.name)}` :
            `${type === AccessType.VARIABLE ? "variable" : "function"} ${stringify(this.name)} not found`;
    }
    /**
     * Returns the variable's current value, or throws if it is not defined
     * in the environment or any of its parents.
     */
    get() {
        return this.env.get(this.name).else(() => this.referenceError());
    }
    /**
     * Assigns the variable. With `create`, the binding is defined directly in
     * this reference's environment (as a constant if `readonly`); otherwise
     * the assignment lands in whichever environment defines the variable,
     * throwing if there is none or it is a constant, and runs that variable's
     * watchers. Either way, a successful assignment invokes the `name`
     * protocol on the new value.
     */
    set(vm: JebVM, value: any, create: boolean, readonly: boolean) {
        if (create) {
            if (readonly) this.env.addConst(this.name, value);
            else this.env.add(this.name, value);
        } else {
            const didSet = this.env.set(this.name, value);
            if (didSet === undefined) {
                this.referenceError();
            } else if (!didSet) {
                throw new JEBError(ErrnoCode.EROFS, `${stringify(this.name)} is a constant`);
            } else {
                didSet.watchers[this.name]?.forEach(w => {
                    pushCommand(vm, OP_shuffle, 1, []);
                    pushCommand(vm, OP_apply, [], undefined, false);
                    pushData(vm, w);
                });
            }
        }
        vm.getProtocol(true, false, "name", [value])?.run(vm, [value], { name: this.name });
    }
    /**
     * Throws the "not found" error for this reference.
     */
    referenceError(): never {
        throw new JEBError(ErrnoCode.ENAME, this.notFoundMessage);
    }
}

// Registers the default `name` protocol: when an unnamed function value is
// assigned to a variable, it adopts the variable's name (used for tracebacks).
export const loadVarNamingBuiltins = (vm: JebVM) => {
    vm.addProtocol("name", {
        type: [[Fun]],
        run(_, { 0: fun }, { name }) { fun.name ??= name; },
        doc: "",
    });
};

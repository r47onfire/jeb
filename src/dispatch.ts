import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { Lambda } from "./callable";
import { Env } from "./env";
import { wrapThrowToError } from "./errors";
import { Type, TypeFor, typeMatches } from "./overload";
import { JebVM } from "./vm";

export abstract class TypeDispatcher {
    constructor(
        /**
         * The type that this dispatcher works with.
         */
        public readonly type: Type
    ) { }
    /**
     * Documentation string for this dispatcher type
     */
    abstract doc: string;
}

/**
 * @param table List of dispatchers
 * @param object Object to be dispatched on
 * @returns The best match dispatcher, or undefined if none match
 */
export const findDispatcherForObject = <T extends TypeDispatcher>(table: T[], object: any): T | undefined => {
    return table.findLast(a => typeMatches(object, a.type));
}

/**
 * Used to specify the number of arguments that a function can be called with.
 * A single number means min = max = that number, and null means min = 0, max = Infinity.
 */
export type Arity = { min: number, max: number } | number | null;

/**
 * Utility object that handles when an object of the specified type is called.
 */
export abstract class Applier<T> extends TypeDispatcher {
    /**
     * Performs the application
     * @param func The thing in function position that is being applied.
     * @param alreadyEvaluated True if the arguments provided are from a synthetic/implicit application, and should not be re-evaluated, even if it's not a macro
     * @param tailcallHint True if this application is a tail call.
     * @param args The unevaluated arguments
     * @param vm The VM to evaluate in
     */
    abstract apply(func: TypeFor<T>, alreadyEvaluated: boolean, tailcallHint: boolean, args: any[], vm: JebVM): void;
    /**
     * Gets the name of the function to appear in tracebacks, if undefined is returned it means it's a hidden callframe and won't show.
     * Note: the apply opcode uses this to determine whether to insert a `jeb:tb_pop` opcode, but it relies on this applier's {@link apply}
     * method to add the corresponding `jeb:tb_push` opcode.
     */
    abstract getNameOf(func: TypeFor<T>): string | undefined;
    /**
     * Gets the minimum and maximum arguments for the function call, this is checked before {@link apply} is called.
     */
    abstract getArity(func: TypeFor<T>): Arity;
    /**
     * Returns true if the functor being called is a macro, and the result should be evaluated again in its caller's scope.
     */
    abstract getIsMacro(func: TypeFor<T>): boolean;
}

/**
 * Utility object that handles when an object of the specified type is evaluated.
 */
export abstract class Evaluator<T> extends TypeDispatcher {
    /**
     * Called to push the opcodes needed to evaluate the object.
     */
    abstract eval(object: TypeFor<T>, tailcallHint: boolean, vm: JebVM): void;
}

/**
 * Utility object that handles when an object of the specified type is indexed.
 */
export abstract class Accessor<T> extends TypeDispatcher {
    /**
     * Called to create the {@link LValue} to implement the get and set operations.
     */
    abstract access(object: TypeFor<T>, field: PropertyKey): LValue;
}

export const enum AccessType {
    VARIABLE,
    FUNCTION,
    PROPERTY,
}

/**
 * Represents a slot that can be assigned to
 */
export interface LValue {
    /**
     * Pushes the value currently in the slot to the top of the stack, or
     * throw an error if it's not readable.
     */
    get(vm: JebVM, accessType: AccessType, shouldBind: boolean): void;
    /**
     * Set the value of the slot to the provided value,
     * or throws an error if it's readonly. The stack should not be modified either way.
     */
    set(vm: JebVM, value: any, accessType: AccessType, createIfNotFound: boolean, makeConstant: boolean): void;
}

export class ObjectLValue implements LValue {
    constructor(public obj: any, public name: PropertyKey) { }
    get(vm: JebVM, _type: AccessType, shouldBind: boolean) {
        var value = this.obj[this.name];
        if (shouldBind && typeof value === "function") value = value.bind(this.obj);
        vm.pushData(value);
    }
    set(vm: JebVM, value: any) {
        wrapThrowToError(vm, "jeb:type_error", () => {
            this.obj[this.name] = value;
        });
    }
}

export class EnvVarLValue implements LValue {
    name: string;
    constructor(public env: Env, name: PropertyKey) {
        this.name = name as string;
    }
    get(vm: JebVM, type: AccessType) {
        const result = this.env.get(this.name);
        if (result.ok) {
            vm.pushData(result.data);
            return;
        }
        this.referenceError(vm, type);
    }
    set(vm: JebVM, value: any, type: AccessType, create: boolean, readonly: boolean) {
        if (create) {
            if (readonly) this.env.addConst(this.name, value);
            else this.env.add(this.name, value);
        } else {
            const didSet = this.env.set(this.name, value);
            if (didSet === undefined) {
                this.referenceError(vm, type);
            } else if (!didSet) {
                vm.pushCommand("jeb:throw", "jeb:type_error", `${stringify(this.name)} is a constant`, {});
            }
        }
        if (isinstance(value, Lambda)) value.name ??= this.name;
    }
    protected referenceError(vm: JebVM, type: AccessType) {
        vm.pushCommand("jeb:throw", "jeb:reference_error",
            type === AccessType.PROPERTY ? `module has no property ${stringify(this.name)}` :
                `${type === AccessType.VARIABLE ? "variable" : "function"} ${stringify(this.name)} not found`, {});
    }
}

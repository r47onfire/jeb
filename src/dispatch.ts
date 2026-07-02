import { isString } from "lib0/function.js";
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

/**
 * Represents a slot that can be assigned to
 */
export interface LValue {
    /**
     * Pushes opcodes to leave the value currently in the slot on the top of the stack, or
     * throw an error if it's not readable.
     */
    get(vm: JebVM): void;
    /**
     * Pushes opcodes to take the top value from the stack and set it to this slot,
     * or throw an error if it's readonly.
     */
    set(vm: JebVM): void;
}


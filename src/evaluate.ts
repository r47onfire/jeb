import { isArray } from "lib0/array";
import { SourceInfo } from "./ir";
import { CallArgs, OP_call_invoke, OP_eval } from "./opcodes";
import { Identifier } from "./utils";
import { CallFrame, JebVM, popData, pushCommand, pushData } from "./vm";

/**
 * JEB's code format: plain JSON values.
 *
 * - A **number**, **boolean**, or **null** evaluates to the layer's value for it
 *   (through the `wrapNumber` / `booleanValue` / `noneValue` hooks -- code
 *   never sits on the data stack, only values do).
 * - A **string** evaluates to the variable of that name. (A string that is meant
 *   as data, not a name, is written `["quote", "the string"]`.)
 * - An **array** is a call form: its elements are expressions, the first
 *   evaluates to the callee and the rest are the arguments. If the first
 *   element is an **object**, it is not an expression at all -- it is the
 *   call's location (the span-injection mechanism: the call is recorded as
 *   occurring at that location), the second element is the callee, and the rest
 *   are the arguments. Objects are valid nowhere else in code.
 * - **undefined** is not valid code and is an error.
 *
 * Locations are opaque to the runtime: a location object is carried as the span
 * of the call's {@link SourceInfo}, in whatever shape the producing compiler
 * uses.
 */
export type JSONCode =
    | null
    | boolean
    | number
    | string
    | JSONCode[]
    | { [key: string]: JSONValue };

/** Any JSON value (code is data: lazy arguments and macro results are these). */
export type JSONValue =
    | null
    | boolean
    | number
    | string
    | JSONValue[]
    | { [key: string]: JSONValue };

/**
 * The location a code form carries, if any: for a call form, its leading
 * location object; for anything else, `undefined`.
 */
export const codeLocation = (code: JSONValue): SourceInfo<any> | undefined => {
    if (
        isArray(code) &&
        code.length > 0 &&
        typeof code[0] === "object" &&
        code[0] !== null
    )
        return { span: code[0] };
    return undefined;
};

interface CallAfterCalleeState {
    argForms: JSONCode[];
    frame: CallFrame<any>;
    tail: boolean;
    name: Identifier | undefined;
}

/**
 * The evaluator: dispatches one JSON code value by its shape. There is no
 * opcode table and there are no named opcodes: scalars are literals, strings
 * are variables, arrays are calls, and everything else -- `quote`, `lambda`,
 * `if`, user macros -- is a value in the builtins environment. How a call's
 * arguments are treated (evaluated, or passed raw to lazy parameters) is the
 * callee's business, decided when the dispatch binds them against the callee's
 * signature.
 */
export const evalJSON = (
    vm: JebVM<any, any>,
    code: JSONValue,
    tail: boolean,
) => {
    if (typeof code === "string") {
        // a string is a variable reference
        pushData(vm, vm.getVariable(code as Identifier));
        return;
    }
    if (isArray(code)) {
        // a call form, possibly headed by a location object
        let location: SourceInfo<any> | undefined;
        if (
            code.length > 0 &&
            typeof code[0] === "object" &&
            code[0] !== null
        ) {
            location = { span: code[0] };
            code = code.slice(1);
        }
        if (code.length === 0)
            throw vm.createError(
                "cannot evaluate an empty call form (a lone location object is not code)",
            );
        const [calleeForm, ...argForms] = code as [JSONCode, ...JSONCode[]];
        const frame: CallFrame<any> = {
            source: location,
            name:
                typeof calleeForm === "string"
                    ? (calleeForm as Identifier)
                    : undefined,
            argSources: argForms.map((form) => codeLocation(form)),
            macroResult: false,
        };
        const state: CallAfterCalleeState = {
            argForms,
            frame,
            tail,
            name: frame.name,
        };
        pushCommand(vm, OP_call_after_callee, state);
        pushCommand(vm, OP_eval, calleeForm, false);
        return;
    }
    if (typeof code === "number") {
        pushData(vm, vm.wrapNumber(code));
        return;
    }
    if (typeof code === "boolean") {
        pushData(vm, vm.booleanValue(code));
        return;
    }
    if (code === null) {
        pushData(vm, vm.noneValue());
        return;
    }
    if (code === undefined) throw vm.createError("undefined is not valid code");
    throw vm.createError(
        "objects are only valid as the location head of a call form",
    );
};

/**
 * The second half of evaluating a call form, once the callee is known: builds
 * the {@link CallArgs} and invokes. The argument forms travel as immediates,
 * unevaluated; the dispatch implementation binds them against the callee's
 * signature.
 */
const OP_call_after_callee = (
    vm: JebVM<any, any>,
    { 0: state }: [state: CallAfterCalleeState],
) => {
    const callee = popData(vm);
    const call: CallArgs<any, any> = {
        callee,
        args: state.argForms,
        env: vm.currentEnv,
        tail: state.tail,
        source: state.frame.source,
        name: state.name,
        argSources: state.frame.argSources,
        frame: state.frame,
    };
    pushCommand(vm, OP_call_invoke, call);
};

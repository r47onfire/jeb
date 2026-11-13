import { isArray } from "lib0/array";
import type { JSONCode } from "./evaluate";
import { argIsEvaluated, CallArgs, evalCallArgs, OP_eval } from "./opcodes";
import { Identifier } from "./utils";
import { JebVM, popData, pushCommand } from "./vm";

/**
 * One parameter of a callable, parsed from its form (see {@link parseSignature}
 * for the forms). A lazy parameter receives its argument's raw form as its
 * value instead of the argument's value; that, together with the
 * `set_macro_result` builtin, is all a "macro" is in JEB: there is no per-value
 * macro flag.
 */
export interface ParamSpec {
    /** The variable the argument is bound to. */
    name: Identifier;
    /** Whether the parameter binds the argument form unevaluated. */
    lazy: boolean;
    /**
     * The form that supplies the argument when the caller passes none, or
     * undefined if the parameter is required. For an evaluated parameter the
     * form is evaluated in the call-site environment; for a lazy one the form
     * itself is the value, exactly as if it had been passed.
     */
    defaultForm?: JSONCode;
}

/** A callable's parameters: the positional ones plus an optional rest. */
export interface Signature {
    params: ParamSpec[];
    rest?: ParamSpec;
}

/**
 * Parses one parameter form: `"name"` is a required evaluated parameter,
 * `"`name"` (backtick-prefixed) a required lazy one, `["name", form]` or
 * `["`name", form]` an optional one with a default form, and `"...name"` or
 * `"...`name"` the rest parameter. Throws a JEB error on anything else.
 */
const parseParam = <D, S>(
    vm: JebVM<D, S>,
    form: JSONCode,
    isRest: boolean,
): ParamSpec => {
    let nameForm: JSONCode = form;
    let defaultForm: JSONCode | undefined;
    if (isArray(form)) {
        if (isRest || form.length !== 2)
            throw vm.createError(
                "a parameter with a default is a [name, default] pair",
            );
        nameForm = form[0]!;
        defaultForm = form[1];
    }
    if (typeof nameForm !== "string")
        throw vm.createError(
            "a parameter is a name string, optionally backtick-prefixed, " +
                "or a [name, default] pair",
        );
    let name: string = nameForm;
    if (isRest) name = name.slice(3);
    let lazy = false;
    if (name.startsWith("`")) {
        lazy = true;
        name = name.slice(1);
    }
    if (name === "") throw vm.createError("a parameter name cannot be empty");
    return { name, lazy, defaultForm };
};

/**
 * Parses a parameter list form (the second element of a `lambda` form, or the
 * spec handed to `makeJSFun`) into a {@link Signature}. A `"...name"` parameter
 * collects the remaining arguments into an array and must come last.
 */
export const parseSignature = <D, S>(
    vm: JebVM<D, S>,
    form: JSONCode,
): Signature => {
    if (!isArray(form))
        throw vm.createError("a parameter list is an array of parameter forms");
    const params: ParamSpec[] = [];
    let rest: ParamSpec | undefined;
    for (const item of form) {
        if (rest !== undefined)
            throw vm.createError("the rest parameter must come last");
        if (typeof item === "string" && item.startsWith("..."))
            rest = parseParam(vm, item, true);
        else params.push(parseParam(vm, item, false));
    }
    return { params, rest };
};

/**
 * State of {@link bindArgs}' default-evaluation step: the missing evaluated
 * parameters still to fill, one form at a time. Rebuilt rather than mutated at
 * each step, like the core's other step states, so a captured continuation sees
 * the state as of the capture.
 */
interface DefaultsState<D> {
    call: CallArgs<D, any>;
    /** Indexes into Signature.params whose defaults are being evaluated. */
    todo: number[];
    /** The values array being assembled (bound values so far). */
    values: (D | undefined)[];
    defaults: Map<number, JSONCode>;
    then: (values: D[]) => void;
}

// The defaults steps are internal machine plumbing (typed at `any`,
// like the core's eval-args steps): the state only shuttles the call
// and its values opaquely. The typed boundary is bindArgs itself.
const OP_bind_defaults_step = (
    vm: JebVM<any, any>,
    { 0: state }: [state: DefaultsState<any>],
) => {
    const { todo, values, defaults } = state;
    if (todo.length === 0) {
        state.then(values);
        return;
    }
    const [index, ...rest] = todo as [number, ...number[]];
    pushCommand(vm, OP_bind_defaults_collect, {
        ...state,
        todo: rest,
        index,
    });
    vm.currentEnv = state.call.env;
    pushCommand(vm, OP_eval, defaults.get(index)!, false);
};

const OP_bind_defaults_collect = (
    vm: JebVM<any, any>,
    { 0: state }: [state: DefaultsState<any> & { index: number }],
) => {
    const values = [...state.values];
    values[state.index] = popData(vm);
    pushCommand(vm, OP_bind_defaults_step, { ...state, values });
};

/**
 * Binds a call's arguments against a signature -- the argument-binding step
 * shared by closures and host functions, so there is only one place arity,
 * laziness, defaults, and rest-bundling are implemented.
 *
 * Each provided argument is evaluated in the call-site environment unless its
 * parameter is lazy, in which case the argument's raw form is its value -- or
 * unless the call itself flags it as an already-computed value ({@link
 * CallArgs.noEval}), as the core's own invocations do. Missing parameters with
 * lazy defaults likewise take the default form itself; missing evaluated
 * defaults are evaluated (in the call-site environment) after the provided
 * arguments. When every value is ready, `then` runs with one value per
 * parameter, plus the rest parameter's array (of values, or of forms if the
 * rest is lazy) last when the signature has one.
 *
 * Argument-count errors are raised before any argument is evaluated.
 */
export const bindArgs = <D, S>(
    vm: JebVM<D, S>,
    call: CallArgs<D, S>,
    { params, rest }: Signature,
    then: (values: D[]) => void,
): void => {
    const provided = call.args.length;
    const required = params.filter((p) => p.defaultForm === undefined).length;
    if (provided < required)
        throw vm.createError(
            `too few arguments: expected ${params.length}, got ${provided}`,
        );
    if (rest === undefined && provided > params.length)
        throw vm.createError(
            `too many arguments: expected ${params.length}, got ${provided}`,
        );
    // An argument the call itself flags as an already-computed value
    // (the core's own invocations -- wind handlers, continuations --
    // pass values, not forms) is taken as-is whatever the parameter
    // says; otherwise the parameter's laziness decides.
    const noEval = call.args.map(
        (_, i) =>
            argIsEvaluated(call, i) ||
            (i < params.length ? params[i]!.lazy : (rest?.lazy ?? false)),
    );
    evalCallArgs(vm, { ...call, noEval }, (_vm, evaluated) => {
        const values: (D | undefined)[] = [];
        const todo: number[] = [];
        const defaults = new Map<number, JSONCode>();
        for (let i = 0; i < params.length; i++) {
            const param = params[i]!;
            if (i < provided) values[i] = evaluated[i];
            else if (param.defaultForm === undefined)
                // unreachable: the required-count check covers it unless
                // a later parameter has a default and an earlier one
                // does not -- then this is the honest error
                throw vm.createError(
                    `too few arguments: expected ${params.length}, got ${provided}`,
                );
            else if (param.lazy) values[i] = param.defaultForm as D;
            else {
                todo.push(i);
                defaults.set(i, param.defaultForm);
            }
        }
        if (rest !== undefined)
            values[params.length] = evaluated.slice(params.length) as D;
        if (todo.length === 0) {
            then(values as D[]);
            return;
        }
        pushCommand(vm, OP_bind_defaults_step, {
            call,
            todo,
            values,
            defaults,
            then,
        });
    });
};

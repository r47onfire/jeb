import { LinkedList_push } from "@r47onfire/game-math";
import { isArray } from "lib0/array";
import { Closure } from "./closure";
import { DynamicWind } from "./continuation";
import { Env } from "./env";
import type { JSONCode } from "./evaluate";
import { SourceInfo } from "./ir";
import { Identifier } from "./utils";
import { CallFrame, JebVM, popData, pushCommand, pushData } from "./vm";

// MARK: the evaluator

/**
 * The evaluator command: hands one code node to the VM's node-execution hook
 * ({@link JebVM.evalNode}). The core does not know the code representation, so
 * this is a trampoline -- what executing a node means is the layer's business.
 * Internal commands below are the continuation steps the evaluator and the
 * dispatch machinery schedule; they are not opcodes and cannot appear in code.
 */
export const OP_eval = (
    vm: JebVM<any, any>,
    { 0: node, 1: tail }: [node: any, tail: boolean],
) => {
    vm.evalNode(node, tail);
};

// MARK: seq

interface SeqState {
    nodes: JSONCode[];
    i: number;
    last: any;
    tail: boolean;
}

/**
 * Schedules a list of nodes as a sequence (see the `seq` opcode). Exported for
 * call-dispatch implementations (see {@link JebVM.dispatchCall}), which invoke
 * block and closure bodies as sequences.
 */
export const seqStart = <D = any, S = any>(
    vm: JebVM<D, S>,
    nodes: JSONCode[],
    tail: boolean,
) => pushCommand(vm, OP_seq_step, { nodes, i: 0, last: vm.noneValue(), tail });

const OP_seq_step = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [SeqState],
) => {
    if (state.i >= state.nodes.length) {
        // a sequence that produced no value at all (it was empty, or every
        // element was a comment) yields None, not the no-value sentinel
        pushData(vm, state.last);
        return;
    }
    const child = state.nodes[state.i]!;
    const isLast = state.i === state.nodes.length - 1;
    // Step states are never mutated: each step schedules the next with a
    // fresh state. A continuation captured mid-sequence holds commands
    // that reference the state, and invoking it must resume with the
    // state as of the capture, not as of whenever the original run ended.
    pushCommand(vm, OP_seq_after, { ...state, i: state.i + 1 });
    pushCommand(vm, OP_eval, child, state.tail && isLast);
};

const OP_seq_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [SeqState],
) => {
    const value = popData(vm);
    pushCommand(vm, OP_seq_step, {
        ...state,
        last: value !== vm.noValue() ? value : state.last,
    });
};

// MARK: calls

/**
 * One call to make: the callee value and its argument nodes, plus the call
 * site's context. This is what the VM's calling-dispatch point ({@link
 * JebVM.dispatchCall}) receives.
 *
 * The arguments arrive UNEVALUATED, as nodes: which of them get evaluated, in
 * what order, and which are instead deferred (wrapped in a block) or skipped
 * entirely is determined by the function being called, not by the `call` opcode
 * -- see {@link evalCallArgs} for the evaluate-them-all path. The one exception
 * is an argument flagged by {@link CallArgs.noEval}: its slot holds an
 * already-computed value instead of a node, to be taken as-is. The core itself
 * calls that way when it invokes a value with arguments it already has in hand
 * (a continuation's value, a dynamic-wind handler's error, and so on).
 */
export interface CallArgs<D = any, S = any> {
    callee: D;
    args: (JSONCode | D)[];
    /**
     * Per-argument "do not evaluate" flags: `true` marks every argument as an
     * already-computed value, an array marks them individually, and `undefined`
     * (the usual case, for calls made by the `call` opcode) marks none.
     */
    noEval?: boolean | boolean[];
    /** The environment of the call site; argument nodes evaluate in it. */
    env: Env<D>;
    /** Whether the call is in tail position. */
    tail: boolean;
    /** Source of the call site, for tracebacks. */
    source: SourceInfo<S> | undefined;
    /** Name the callee was referred to by at the call site, if known. */
    name: Identifier | undefined;
    /** Source of each argument form, in order (for blame placement). */
    argSources?: (SourceInfo<S> | undefined)[];
    /**
     * The call's frame (see {@link CallFrame}): pushed onto the VM's frame
     * stack for the duration of the call by {@link OP_call_invoke}. Created by
     * the evaluator; internal core calls may omit it (a default is made).
     */
    frame?: CallFrame<S>;
}

/** Whether argument `i` of the call is flagged as an already-computed value. */
export const argIsEvaluated = <D, S>(
    call: CallArgs<D, S>,
    i: number,
): boolean =>
    call.noEval === true || (isArray(call.noEval) && call.noEval[i] === true);

interface CallState<S> {
    argNodes: JSONCode[];
    tail: boolean;
    source: SourceInfo<S> | undefined;
    name: Identifier | undefined;
}

export const OP_call_start = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [state: CallState<S>],
) => {
    const callee = popData(vm);
    pushCommand(vm, OP_call_invoke, {
        callee,
        args: state.argNodes,
        env: vm.currentEnv,
        tail: state.tail,
        source: state.source,
        name: state.name,
    });
};

// MARK: argument evaluation for dispatch implementations

interface EvalArgsState<D, S> {
    call: CallArgs<D, S>;
    i: number;
    values: D[];
    then: (vm: JebVM<D, S>, values: any[]) => void;
}

/**
 * Evaluates a call's arguments for a dispatch implementation (see
 * {@link JebVM.dispatchCall}) that wants them as values: each argument node is
 * evaluated in the call site's environment ({@link CallArgs.env}), in order,
 * except the ones flagged {@link CallArgs.noEval}, whose slots already hold
 * their values. When every argument is resolved, `then` runs with the values.
 * With no arguments at all, `then` runs immediately.
 */
export const evalCallArgs = <D = any, S = any>(
    vm: JebVM<D, S>,
    call: CallArgs<D, S>,
    then: (vm: JebVM<D, S>, values: any[]) => void,
) => {
    if (call.args.length === 0) {
        then(vm, []);
        return;
    }
    vm.currentEnv = call.env;
    pushCommand(vm, OP_eval_args_step, { call, i: 0, values: [], then });
};

// The eval-args steps are internal machine plumbing (typed at `any`, like
// the wind steps): the state only ever shuttles the call and its values
// opaquely. The typed boundary is evalCallArgs itself.
const OP_eval_args_step = (
    vm: JebVM<any, any>,
    { 0: state }: [state: EvalArgsState<any, any>],
) => {
    // already-computed arguments are taken as-is, without scheduling
    let { i, values } = state;
    while (i < state.call.args.length && argIsEvaluated(state.call, i)) {
        values = [...values, state.call.args[i]];
        i++;
    }
    if (i >= state.call.args.length) {
        state.then(vm, values);
        return;
    }
    const node = state.call.args[i];
    pushCommand(vm, OP_eval_args_collect, { ...state, i: i + 1, values });
    pushCommand(vm, OP_eval, node, false);
};

const OP_eval_args_collect = (
    vm: JebVM<any, any>,
    { 0: state }: [state: EvalArgsState<any, any>],
) => {
    pushCommand(vm, OP_eval_args_step, {
        ...state,
        values: [...state.values, popData(vm)],
    });
};

/**
 * The calling-dispatch command: hands one call to the VM's dispatch point
 * ({@link JebVM.dispatchCall}), with its arguments still unevaluated (see
 * {@link CallArgs}). The core itself has no calling semantics -- the dispatch
 * point is abstract, and the layer above provides the real implementation. This
 * command is also used internally wherever the runtime itself needs to call a
 * value.
 */
export const OP_call_invoke = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: call }: [call: CallArgs<D, S>],
) => {
    const frame: CallFrame<S> = (call.frame ??= {
        source: call.source,
        name: call.name,
        argSources: call.argSources ?? [],
        macroResult: false,
    });
    vm.callFrames = LinkedList_push(vm.callFrames, frame);
    // After everything the dispatch schedules has run: the frame pop
    // runs first (it is pushed last), then the macro-result check, which
    // re-evaluates the result if the call set the flag -- in the
    // caller's environment, with this call's frame already gone.
    pushCommand(vm, OP_macro_check, frame, call.tail);
    pushCommand(vm, OP_call_frame_pop, frame);
    vm.dispatchCall(call);
};

const OP_call_frame_pop = (
    vm: JebVM<any, any>,
    { 0: frame }: [frame: CallFrame<any>],
) => {
    // A dispatch that arranged the call's result itself (SCHEDULED) may
    // already have popped this frame to make the call transparent; only
    // pop if it is still the innermost one.
    if (vm.callFrames?.value === frame)
        vm.callFrames = vm.callFrames?.next ?? null;
};

/**
 * Scheduled after every call: if the call set its result flag (see
 * `set_macro_result`), the value it returned is code and is re-evaluated here,
 * in the caller's environment (which the call's return machinery has already
 * restored); otherwise it is simply the call's result and is left on the
 * stack.
 */
export const OP_macro_check = (
    vm: JebVM<any, any>,
    { 0: frame, 1: tail }: [frame: CallFrame<any>, tail: boolean],
) => {
    if (!frame.macroResult) return;
    const code = popData(vm);
    pushCommand(vm, OP_eval, code, tail);
};

/**
 * The return step for a call that switched environments: restores the caller's
 * environment, drops the call's traceback frame (unless the call was in tail
 * position, in which case the frame is dropped by the return it tail-called
 * from), and leaves the body's result on the data stack. Exported for
 * call-dispatch implementations (see {@link JebVM.dispatchCall}).
 */
export const OP_call_return = <D = any, S = any>(
    vm: JebVM<D, S>,
    {
        0: env,
        1: shouldPopTraceback,
    }: [env: Env<D>, shouldPopTraceback: boolean],
) => {
    const value = popData(vm);
    vm.currentEnv = env;
    // A tail call's frame is dropped by the return of the call it tail-
    // called from (popTraceback drops tail frames before its own).
    if (shouldPopTraceback) vm.popTraceback();
    pushData(vm, value);
};

/** Calls a value and discards its result, leaving the data stack as it was. */
export const OP_call_and_ignore_result = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: callee, 1: args }: [callee: D, args: any[]],
) => {
    pushCommand(vm, OP_discard);
    pushCommand(vm, OP_call_invoke, {
        callee,
        args,
        noEval: true,
        env: vm.currentEnv,
        tail: false,
        source: undefined,
        name: undefined,
    });
};

const OP_discard = (vm: JebVM<any, any>) => {
    popData(vm);
};

// MARK: let

interface LetState<D, S> {
    binds: [name: Identifier, valueNode: JSONCode][];
    i: number;
    values: any[];
    body: any[];
    tail: boolean;
    outerEnv: Env<D>;
}

/**
 * Starts a `let`: schedules evaluation of the binding value nodes (in the outer
 * environment) and, once collected, the body in a child environment. Parsing
 * the binding syntax is the layer's business; this is the state machine it
 * hands the parsed pieces to.
 */
export const letStart = <D = any, S = any>(
    vm: JebVM<D, S>,
    binds: [name: Identifier, valueNode: JSONCode][],
    body: JSONCode[],
    tail: boolean,
) => {
    const state: LetState<D, S> = {
        binds,
        i: 0,
        values: [],
        body,
        tail,
        outerEnv: vm.currentEnv,
    };
    pushCommand(vm, OP_let_step, state);
};

const OP_let_step = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [LetState<D, S>],
) => {
    if (state.i >= state.binds.length) {
        const env = vm.createEnv(state.outerEnv);
        state.binds.forEach(([name], i) => {
            const value = state.values[i];
            if (value instanceof Closure && value.name === undefined)
                value.name = name;
            env.add(name, value);
        });
        pushCommand(vm, OP_let_after, state.outerEnv);
        vm.currentEnv = env;
        seqStart(vm, state.body, state.tail);
        return;
    }
    pushCommand(vm, OP_let_collect, { ...state, i: state.i + 1 });
    pushCommand(vm, OP_eval, state.binds[state.i]![1], false);
};

const OP_let_collect = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [LetState<D, S>],
) => {
    pushCommand(vm, OP_let_step, {
        ...state,
        values: [...state.values, popData(vm)],
    });
};

const OP_let_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: outerEnv }: [outerEnv: Env<D>],
) => {
    const value = popData(vm);
    vm.currentEnv = outerEnv;
    pushData(vm, value);
};

// MARK: definition and assignment

export const OP_define_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: name, 1: constant }: [name: Identifier, constant: boolean],
) => {
    const value = popData(vm);
    if (value instanceof Closure && value.name === undefined) value.name = name;
    vm.defineVariable(name, value, constant);
    pushData(vm, value);
};

export const OP_assign_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: name }: [name: Identifier],
) => {
    const value = popData(vm);
    vm.assignVariable(name, value);
    pushData(vm, value);
};

// MARK: control opcodes' continuation steps

export const OP_if_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    {
        0: consequent,
        1: alternate,
        2: hasAlternate,
        3: tail,
    }: [
        consequent: JSONCode,
        alternate: JSONCode,
        hasAlternate: boolean,
        tail: boolean,
    ],
) => {
    // The condition is converted through the VM's boolify hook (in Kuiper
    // this queues a `__bool__` call), and the converted value is what
    // OP_if_boolified judges with isTruthy.
    const condition = popData(vm);
    pushCommand(vm, OP_if_boolified, consequent, alternate, hasAlternate, tail);
    vm.boolify(condition);
};

const OP_if_boolified = <D = any, S = any>(
    vm: JebVM<D, S>,
    {
        0: consequent,
        1: alternate,
        2: hasAlternate,
        3: tail,
    }: [
        consequent: JSONCode,
        alternate: JSONCode,
        hasAlternate: boolean,
        tail: boolean,
    ],
) => {
    if (vm.isTruthy(popData(vm))) {
        pushCommand(vm, OP_eval, consequent, tail);
    } else if (hasAlternate) {
        pushCommand(vm, OP_eval, alternate, tail);
    } else {
        // `if` with a false condition and no else branch produces None
        pushData(vm, vm.noneValue());
    }
};

export const OP_callcc_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: source }: [source: SourceInfo<S> | undefined],
) => {
    const callee = popData(vm);
    const continuation = vm.cc();
    pushCommand(vm, OP_call_invoke, {
        callee,
        args: [continuation],
        noEval: true,
        env: vm.currentEnv,
        tail: false,
        source,
        name: undefined,
    });
};

export const OP_throw_value = (vm: JebVM<any, any>) => {
    const value = popData(vm);
    if (vm.isError(value)) throw value;
    throw vm.createError(String(value));
};

/**
 * The error-unwinding command the VM schedules when an error value (see
 * {@link JebVM.isError}) is thrown: runs each dynamic-wind exit handler it
 * passes (with the error and a `false` isFromContinuation flag) and finally
 * parks the error on the VM for the host to see.
 *
 * An exit handler can stop the error from propagating any further by returning
 * exactly `true` (see {@link OP_throw_after_exit}): the error is then
 * considered handled, and execution resumes with the state the winder restored.
 * That is the whole recovery mechanism -- `try`/`catch` and other
 * recoverable-error constructs in the layers above are built out of
 * `dynamic-wind` plus this rule, with no further core support.
 */
export const OP_throw = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: err }: [err: D],
) => {
    while (vm.curDynamicWind.parent) {
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        dw.restore(vm);
        if (dw.handler?.exit) {
            pushCommand(vm, OP_throw_after_exit, err);
            pushCommand(vm, OP_call_invoke, {
                callee: dw.handler.exit,
                args: [err, vm.booleanValue(false)],
                noEval: true,
                env: vm.currentEnv,
                tail: false,
                source: undefined,
                name: undefined,
            });
            return;
        }
    }
    vm.expansionStack.length = 0;
    vm.error = err;
};

/**
 * The step after one exit handler has run during error unwinding: if the
 * handler returned exactly `true`, the error is handled and propagation stops
 * -- execution continues with the restored state, and the `dynamic-wind` whose
 * handler caught the error produces no value (the VM's no-value sentinel). Any
 * other result, and the error keeps unwinding to the next winder out.
 */
const OP_throw_after_exit = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: err }: [err: D],
) => {
    if (popData(vm) === true) {
        pushData(vm, vm.noneValue());
        return;
    }
    pushCommand(vm, OP_throw, err);
};

// MARK: dynamic-wind

/**
 * Starts a dynamic-wind: installs a fresh winder with the given handler values,
 * then runs (in command order) the `body` call and the `enter` call. The
 * handler values are already evaluated -- collecting them from code is the
 * layer's business (its `dynamic-wind` opcode); the state machine from here on
 * (`OP_wind_body`, `OP_wind_exit`) is the core's.
 *
 * Enter handlers take one argument, `isFromContinuation` (materialized through
 * {@link JebVM.booleanValue}): `false` here, `true` when a continuation jump
 * re-enters the wind. Exit handlers take two: the error (or the None value when
 * there is none) and `isFromContinuation` -- see {@link OP_throw} and
 * `DynamicWind.processJumpHere`.
 */
export const windStart = (
    vm: JebVM<any, any>,
    enter: any,
    body: any,
    exit: any,
    source: SourceInfo<any> | undefined,
) => {
    const dw = vm.newDynamicWind();
    dw.setHandler({ enter, exit });
    vm.curDynamicWind = dw;
    pushCommand(vm, OP_wind_body, dw, body, source);
    pushCommand(vm, OP_call_invoke, {
        callee: enter,
        args: [vm.booleanValue(false)],
        noEval: true,
        env: vm.currentEnv,
        tail: false,
        source,
        name: undefined,
    });
};

// The wind steps below are internal machine plumbing (like OP_discard):
// they are typed at `any` rather than over the VM's <D, S>, because the
// winder and environment types are invariant in D and the steps only ever
// shuffle them opaquely. The typed boundary is windStart, which creates
// the winder.
const OP_wind_body = (
    vm: JebVM<any, any>,
    {
        0: dw,
        1: body,
        2: source,
    }: [
        dw: DynamicWind<any, any>,
        body: any,
        sourceInfo: SourceInfo<any> | undefined,
    ],
) => {
    popData(vm); // the enter handler's result
    pushCommand(vm, OP_wind_exit, { dw, source, result: vm.noneValue() });
    pushCommand(vm, OP_call_invoke, {
        callee: body,
        args: [],
        env: vm.currentEnv,
        tail: false,
        source,
        name: undefined,
    });
};

interface WindExitArgs {
    dw: DynamicWind<any, any>;
    source: SourceInfo<any> | undefined;
    result: any;
}

const OP_wind_exit = (
    vm: JebVM<any, any>,
    { 0: state }: [state: WindExitArgs],
) => {
    state.result = popData(vm);
    pushCommand(vm, OP_wind_finish, state);
    pushCommand(vm, OP_call_invoke, {
        callee: state.dw.handler!.exit,
        args: [vm.noneValue(), vm.booleanValue(false)],
        noEval: true,
        env: vm.currentEnv,
        tail: false,
        source: state.source,
        name: undefined,
    });
};

const OP_wind_finish = (vm: JebVM<any, any>, [state]: [WindExitArgs]) => {
    popData(vm); // the exit handler's result
    vm.curDynamicWind = state.dw.parent!;
    pushData(vm, state.result);
};

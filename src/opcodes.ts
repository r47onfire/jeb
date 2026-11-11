import { Block } from "./block";
import { Env } from "./env";
import { Closure } from "./closure";
import { DynamicWind } from "./continuation";
import { IRNode, isIRNode, markExpansion, nodeSource, SourceInfo } from "./ir";
import { Identifier, isIdentifier } from "./utils";
import { JebVM, popData, pushCommand, pushData } from "./vm";

/**
 * The context handed to an opcode handler when its node is evaluated. The
 * handler runs pre-order: no operand has been evaluated yet, and the handler
 * decides which operands to evaluate (through {@link eval}), which to skip, and
 * which to evaluate more than once.
 *
 * A handler must arrange for exactly one result to be left on the data stack
 * when its node is done -- a value, or the VM's no-value sentinel (see
 * {@link JebVM.noValue}) for "this node produced no value" -- either by pushing
 * it directly or by scheduling commands that do.
 */
export interface OpcodeContext<S = any> {
    /** The node being evaluated. */
    readonly node: IRNode<S>;
    /** The node's opcode name (`node[0]`). */
    readonly op: string;
    /** The node's normalized source, if it has one. */
    readonly source: SourceInfo<S> | undefined;
    /** The node's operands (`node.slice(2)`), all unevaluated. */
    readonly operands: IRNode<S>[];
    /** Whether this node is in tail position. */
    readonly tail: boolean;
    /**
     * Schedules evaluation of a child node. Its result is on the data stack
     * when the next command scheduled by this handler runs.
     */
    eval(node: IRNode<S>, tail?: boolean): void;
    /**
     * Like {@link eval}, but for code produced by expanding this node (a macro
     * call, an `eval`, ...): the child is stamped with this node's source as
     * its expansion source before it is scheduled.
     */
    evalExpanded(node: IRNode<S>): void;
}

/** Implements one opcode of the IR. See {@link OpcodeContext}. */
export type OpcodeHandler<D = any, S = any> = (
    vm: JebVM<D, S>,
    ctx: OpcodeContext<S>,
) => void;

// MARK: the evaluator

/**
 * The evaluator command: dispatches one IR node to its opcode handler. Internal
 * commands below are the continuation steps the handlers schedule; they are not
 * opcodes and cannot appear in code.
 */
export const OP_eval = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: node, 1: tail }: [node: IRNode<S>, tail: boolean],
) => {
    if (!isIRNode(node))
        throw vm.createError(`cannot evaluate a non-node: ${String(node)}`);
    const opName = node[0]!;
    const handler = vm.opcodes[opName];
    if (!handler) throw vm.createError(`unknown opcode: ${opName}`);
    const source = nodeSource(node);
    const ctx: OpcodeContext<S> = {
        node,
        op: opName,
        source,
        operands: node.slice(2),
        tail,
        eval: (child, childTail = false) =>
            pushCommand(vm, OP_eval, child, childTail),
        evalExpanded: (child) =>
            pushCommand(vm, OP_eval, markExpansion(child, source), tail),
    };
    if (source?.expandedFrom) {
        vm.expansionStack.push(source);
        pushCommand(vm, OP_pop_expansion);
    }
    handler(vm, ctx);
};

const OP_pop_expansion = <D = any, S = any>(vm: JebVM<D, S>) => {
    const value = popData(vm);
    vm.expansionStack.pop();
    pushData(vm, value);
};

// MARK: seq

interface SeqState<D, S> {
    nodes: IRNode<S>[];
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
    nodes: IRNode<S>[],
    tail: boolean,
) => pushCommand(vm, OP_seq_step, { nodes, i: 0, last: vm.noneValue(), tail });

const OP_seq_step = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [SeqState<D, S>],
) => {
    if (state.i >= state.nodes.length) {
        // a sequence that produced no value at all (it was empty, or every
        // element was a comment) yields None, not the no-value sentinel
        pushData(vm, state.last);
        return;
    }
    const child = state.nodes[state.i]!;
    const isLast = state.i === state.nodes.length - 1;
    state.i++;
    pushCommand(vm, OP_seq_after, state);
    pushCommand(vm, OP_eval, child, state.tail && isLast);
};

const OP_seq_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [SeqState<D, S>],
) => {
    const value = popData(vm);
    if (value !== vm.noValue()) state.last = value;
    pushCommand(vm, OP_seq_step, state);
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
    args: (IRNode<S> | D)[];
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
}

/** Whether argument `i` of the call is flagged as an already-computed value. */
export const argIsEvaluated = <D, S>(
    call: CallArgs<D, S>,
    i: number,
): boolean =>
    call.noEval === true ||
    (Array.isArray(call.noEval) && call.noEval[i] === true);

interface CallState<S> {
    argNodes: IRNode<S>[];
    tail: boolean;
    source: SourceInfo<S> | undefined;
    name: Identifier | undefined;
}

const OP_call_start = <D = any, S = any>(
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
    values: any[];
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
    while (
        state.i < state.call.args.length &&
        argIsEvaluated(state.call, state.i)
    ) {
        state.values.push(state.call.args[state.i]);
        state.i++;
    }
    if (state.i >= state.call.args.length) {
        state.then(vm, state.values);
        return;
    }
    const node = state.call.args[state.i] as IRNode<any>;
    state.i++;
    pushCommand(vm, OP_eval_args_collect, state);
    pushCommand(vm, OP_eval, node, false);
};

const OP_eval_args_collect = (
    vm: JebVM<any, any>,
    { 0: state }: [state: EvalArgsState<any, any>],
) => {
    state.values.push(popData(vm));
    pushCommand(vm, OP_eval_args_step, state);
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
    vm.dispatchCall(call);
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
        1: shouldPopTraceback
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
    binds: [name: Identifier, valueNode: IRNode<S>][];
    i: number;
    values: any[];
    body: any[];
    tail: boolean;
    outerEnv: Env<D>;
}

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
    pushCommand(vm, OP_let_collect, state);
    pushCommand(vm, OP_eval, state.binds[state.i]![1], false);
};

const OP_let_collect = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [LetState<D, S>],
) => {
    state.values.push(popData(vm));
    state.i++;
    pushCommand(vm, OP_let_step, state);
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

const OP_define_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: name, 1: constant }: [name: Identifier, constant: boolean],
) => {
    const value = popData(vm);
    if (value instanceof Closure && value.name === undefined) value.name = name;
    if (constant) vm.currentEnv.addConst(name, value);
    else vm.currentEnv.add(name, value);
    pushData(vm, value);
};

const OP_assign_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: name }: [name: Identifier],
) => {
    const value = popData(vm);
    const scope = vm.currentEnv.set(name, value);
    if (scope === undefined)
        throw vm.createError(
            `cannot assign to undefined variable: ${String(name)}`,
        );
    if (scope === false)
        throw vm.createError(`cannot assign to constant: ${String(name)}`);
    pushData(vm, value);
};

// MARK: control opcodes' continuation steps

const OP_if_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    {
        0: consequent,
        1: alternate,
        2: hasAlternate,
        3: tail,
    }: [consequent: any, alternate: any, hasAlternate: boolean, tail: boolean],
) => {
    const condition = popData(vm);
    // The core `if` branches on host truthiness. Converting a language's
    // values to booleans is that language's job, not the core's.
    if (condition) pushCommand(vm, OP_eval, consequent, tail);
    else if (hasAlternate) pushCommand(vm, OP_eval, alternate, tail);
    else pushData(vm, vm.noneValue());
};

const OP_callcc_after = <D = any, S = any>(
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

const OP_eval_after = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: source, 1: tail }: [source: SourceInfo<S> | undefined, tail: boolean],
) => {
    const code = popData(vm);
    if (!isIRNode(code))
        throw vm.createError("eval: the value is not an IR node");
    pushCommand(vm, OP_eval, markExpansion(code, source), tail);
};

const OP_throw_value = (vm: JebVM<any, any>) => {
    const value = popData(vm);
    if (vm.isError(value)) throw value;
    throw vm.createError(String(value));
};

/**
 * The error-unwinding command the VM schedules when an error value (see
 * {@link JebVM.isError}) is thrown: runs each dynamic-wind exit handler it
 * passes (with the error as its argument) and finally parks the error on the VM
 * for the host to see.
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
                args: [err],
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

interface WindCollectState<D, S> {
    nodes: IRNode<S>[];
    i: number;
    values: D[];
    source: SourceInfo<S> | undefined;
}

const OP_wind_step = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [state: WindCollectState<D, S>],
) => {
    if (state.i >= state.nodes.length) {
        const { 0: enter, 1: body, 2: exit } = state.values as [any, any, any];
        const dw = vm.newDynamicWind();
        dw.setHandler({ enter, exit });
        vm.curDynamicWind = dw;
        pushCommand(vm, OP_wind_body, dw, body, state.source);
        pushCommand(vm, OP_call_invoke, {
            callee: enter,
            args: [],
            env: vm.currentEnv,
            tail: false,
            source: state.source,
            name: undefined,
        });
        return;
    }
    const node = state.nodes[state.i]!;
    state.i++;
    pushCommand(vm, OP_wind_collect, state);
    pushCommand(vm, OP_eval, node, false);
};

const OP_wind_collect = <D = any, S = any>(
    vm: JebVM<D, S>,
    { 0: state }: [state: WindCollectState<D, S>],
) => {
    state.values.push(popData(vm));
    pushCommand(vm, OP_wind_step, state);
};

// The wind steps below are internal machine plumbing (like OP_discard):
// they are typed at `any` rather than over the VM's <D, S>, because the
// winder and environment types are invariant in D and the steps only ever
// shuffle them opaquely. The typed boundary is OP_wind_step, which creates
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
        args: [vm.noneValue()],
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

// MARK: the core opcode table

const checkArity = (
    vm: JebVM<any, any>,
    ctx: OpcodeContext,
    min: number,
    max = min,
) => {
    const n = ctx.operands.length;
    if (n < min || n > max)
        throw vm.createError(
            `${ctx.op}: expected ${min === max ? min : `${min} to ${max}`} operands, got ${n}`,
        );
};

const checkName = (
    vm: JebVM<any, any>,
    ctx: OpcodeContext,
    operand: any,
): Identifier => {
    if (!isIdentifier(operand))
        throw vm.createError(`${ctx.op}: expected a name operand`);
    return operand;
};

/**
 * Installs the core opcodes into the VM's opcode table. The core is
 * deliberately small -- data, sequencing, variables, conditionals, functions,
 * continuations, and evaluation. Everything semantic (operators, objects,
 * keyword arguments, collections) belongs to the layer above, which registers
 * its own opcodes and host functions.
 */
export const loadCoreOpcodes = <D = any, S = any>(vm: JebVM<D, S>) => {
    const defineOpcode = (name: string, handler: OpcodeHandler<D, S>) =>
        vm.defineOpcode(name, handler);

    defineOpcode("const", (vm, ctx) => {
        checkArity(vm, ctx, 1);
        // The operand is data: it is never evaluated, even if it is
        // node-shaped.
        pushData(vm, ctx.operands[0]);
    });

    defineOpcode("comment", (vm) => {
        // The operands are never evaluated, and the result is no value.
        pushData(vm, vm.noValue());
    });

    defineOpcode("seq", (vm, ctx) => {
        seqStart(vm, ctx.operands, ctx.tail);
    });

    defineOpcode("var", (vm, ctx) => {
        checkArity(vm, ctx, 1);
        const name = checkName(vm, ctx, ctx.operands[0]);
        pushData(
            vm,
            vm.currentEnv.get(name).else(() => {
                throw vm.createError(`no such variable: ${String(name)}`);
            }),
        );
    });

    defineOpcode("define", (vm, ctx) => {
        checkArity(vm, ctx, 2);
        pushCommand(
            vm,
            OP_define_after,
            checkName(vm, ctx, ctx.operands[0]),
            false,
        );
        ctx.eval(ctx.operands[1]!);
    });

    defineOpcode("define-const", (vm, ctx) => {
        checkArity(vm, ctx, 2);
        pushCommand(
            vm,
            OP_define_after,
            checkName(vm, ctx, ctx.operands[0]),
            true,
        );
        ctx.eval(ctx.operands[1]!);
    });

    defineOpcode("assign", (vm, ctx) => {
        checkArity(vm, ctx, 2);
        pushCommand(vm, OP_assign_after, checkName(vm, ctx, ctx.operands[0]));
        ctx.eval(ctx.operands[1]!);
    });

    defineOpcode("let", (vm, ctx) => {
        const binds: LetState<D, S>["binds"] = [];
        var i: number;
        for (
            i = 0;
            i < ctx.operands.length &&
            isIRNode(ctx.operands[i]) &&
            ctx.operands[i]![0] === "bind";
            i++
        ) {
            const bind = ctx.operands[i]!;
            if (bind.length !== 4)
                throw vm.createError("bind: expected a name and a value node");
            binds.push([checkName(vm, ctx, bind[2]), bind[3]]);
        }
        pushCommand(vm, OP_let_step, {
            binds,
            i: 0,
            values: [],
            body: ctx.operands.slice(i),
            tail: ctx.tail,
            outerEnv: vm.currentEnv,
        } satisfies LetState<D, S>);
    });

    defineOpcode("bind", (vm) => {
        throw vm.createError("bind: only meaningful as an operand of let");
    });

    defineOpcode("lambda", (vm, ctx) => {
        if (ctx.operands.length < 1)
            throw vm.createError("lambda: expected a parameter list");
        const paramsData = ctx.operands[0];
        if (!Array.isArray(paramsData))
            throw vm.createError(
                "lambda: parameters must be an array of names",
            );
        const params: Identifier[] = [];
        let rest: Identifier | undefined;
        paramsData.forEach((param, i) => {
            if (typeof param === "string" && param.startsWith("...")) {
                if (i !== paramsData.length - 1)
                    throw vm.createError(
                        "lambda: a rest parameter must come last",
                    );
                rest = param.slice(3);
                if (!rest)
                    throw vm.createError("lambda: rest parameter needs a name");
            } else if (isIdentifier(param)) params.push(param);
            else throw vm.createError("lambda: parameters must be names");
        });
        pushData(
            vm,
            new Closure(
                params,
                rest,
                new Block(vm.currentEnv, ctx.operands.slice(1)),
            ),
        );
    });

    defineOpcode("block", (vm, ctx) => {
        // The operands are the block's body: they are not evaluated now,
        // only when the block is invoked.
        pushData(vm, new Block(vm.currentEnv, ctx.operands));
    });

    defineOpcode("call", (vm, ctx) => {
        if (ctx.operands.length < 1)
            throw vm.createError("call: expected at least a callee node");
        const calleeNode = ctx.operands[0]!;
        const state: CallState<S> = {
            argNodes: ctx.operands.slice(1),
            tail: ctx.tail,
            source: ctx.source,
            name:
                isIRNode(calleeNode) && calleeNode[0] === "var"
                    ? (calleeNode[2] as Identifier)
                    : undefined,
        };
        pushCommand(vm, OP_call_start, state);
        ctx.eval(calleeNode);
    });

    defineOpcode("if", (vm, ctx) => {
        checkArity(vm, ctx, 2, 3);
        pushCommand(
            vm,
            OP_if_after,
            ctx.operands[1],
            ctx.operands[2],
            ctx.operands.length > 2,
            ctx.tail,
        );
        ctx.eval(ctx.operands[0]!);
    });

    defineOpcode("callcc", (vm, ctx) => {
        checkArity(vm, ctx, 1);
        pushCommand(vm, OP_callcc_after, ctx.source);
        ctx.eval(ctx.operands[0]!);
    });

    defineOpcode("dynamic-wind", (vm, ctx) => {
        checkArity(vm, ctx, 3);
        pushCommand(vm, OP_wind_step, {
            nodes: ctx.operands,
            i: 0,
            values: [],
            source: ctx.source,
        } satisfies WindCollectState<D, S>);
    });

    defineOpcode("eval", (vm, ctx) => {
        checkArity(vm, ctx, 1);
        pushCommand(vm, OP_eval_after, ctx.source, ctx.tail);
        ctx.eval(ctx.operands[0]!);
    });

    defineOpcode("throw", (vm, ctx) => {
        checkArity(vm, ctx, 1);
        pushCommand(vm, OP_throw_value);
        ctx.eval(ctx.operands[0]!);
    });
};

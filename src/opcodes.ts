import { Block } from "./block";
import { Closure } from "./closure";
import { Continuation } from "./continuation";
import { JEBError, promisifyVM, wrapThrowToError } from "./errors";
import {
    IRNode,
    isIRNode,
    markExpansion,
    NO_VALUE,
    nodeSource,
    SourceInfo,
} from "./ir";
import { Identifier, isIdentifier } from "./utils";
import { JebVM, popData, pushCommand, pushData, StackEntryKind } from "./vm";

/**
 * The context handed to an opcode handler when its node is evaluated. The
 * handler runs pre-order: no operand has been evaluated yet, and the handler
 * decides which operands to evaluate (through {@link eval}), which to skip, and
 * which to evaluate more than once.
 *
 * A handler must arrange for exactly one result to be left on the data stack
 * when its node is done -- a value, or {@link NO_VALUE} for "this node produced
 * no value" -- either by pushing it directly or by scheduling commands that
 * do.
 */
export interface OpcodeContext<S = any> {
    /** The node being evaluated. */
    readonly node: IRNode<S>;
    /** The node's opcode name (`node[0]`). */
    readonly op: string;
    /** The node's normalized source, if it has one. */
    readonly source: SourceInfo<S> | undefined;
    /** The node's operands (`node.slice(2)`), all unevaluated. */
    readonly operands: any[];
    /** Whether this node is in tail position. */
    readonly tail: boolean;
    /**
     * Schedules evaluation of a child node. Its result is on the data stack
     * when the next command scheduled by this handler runs.
     */
    eval(node: IRNode<any>, tail?: boolean): void;
    /**
     * Like {@link eval}, but for code produced by expanding this node (a macro
     * call, an `eval`, ...): the child is stamped with this node's source as
     * its expansion source before it is scheduled.
     */
    evalExpanded(node: IRNode<any>): void;
}

/** Implements one opcode of the IR. See {@link OpcodeContext}. */
export type OpcodeHandler<S = any> = (vm: JebVM, ctx: OpcodeContext<S>) => void;

/** A host (Javascript) function callable from IR code through `call`. */
export type HostFunction = (vm: JebVM, ...args: any[]) => any;

const syntaxError = (message: string) => new JEBError(message);

// MARK: the evaluator

/**
 * The evaluator command: dispatches one IR node to its opcode handler. Internal
 * commands below are the continuation steps the handlers schedule; they are not
 * opcodes and cannot appear in code.
 */
export const OP_eval = (
    vm: JebVM,
    { 0: node, 1: tail }: [node: IRNode<any>, tail: boolean],
) => {
    if (!isIRNode(node))
        throw syntaxError(`cannot evaluate a non-node: ${String(node)}`);
    const opName = node[0]!;
    const handler = vm.opcodes[opName];
    if (!handler) throw syntaxError(`unknown opcode: ${opName}`);
    const source = nodeSource(node);
    const ctx: OpcodeContext = {
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

const OP_pop_expansion = (vm: JebVM) => {
    const value = popData(vm);
    vm.expansionStack.pop();
    pushData(vm, value);
};

// MARK: seq

interface SeqState {
    nodes: any[];
    i: number;
    last: any;
    tail: boolean;
}

const seqStart = (vm: JebVM, nodes: any[], tail: boolean) =>
    pushCommand(vm, OP_seq_step, { nodes, i: 0, last: NO_VALUE, tail });

const OP_seq_step = (vm: JebVM, [state]: [SeqState]) => {
    if (state.i >= state.nodes.length) {
        pushData(vm, state.last);
        return;
    }
    const child = state.nodes[state.i]!;
    const isLast = state.i === state.nodes.length - 1;
    state.i++;
    pushCommand(vm, OP_seq_after, state);
    pushCommand(vm, OP_eval, child, state.tail && isLast);
};

const OP_seq_after = (vm: JebVM, [state]: [SeqState]) => {
    const value = popData(vm);
    if (value !== NO_VALUE) state.last = value;
    pushCommand(vm, OP_seq_step, state);
};

// MARK: calls

interface CallArgs {
    callee: any;
    args: any[];
    tail: boolean;
    source: SourceInfo<any> | undefined;
    name: Identifier | undefined;
}

interface CallCollectState {
    argNodes: any[];
    i: number;
    values: any[];
    tail: boolean;
    source: SourceInfo<any> | undefined;
    name: Identifier | undefined;
}

const OP_call_start = (vm: JebVM, [state]: [CallCollectState]) => {
    const callee = popData(vm);
    state.i = 0;
    pushCommand(vm, OP_call_step, state, callee);
};

const OP_call_step = (vm: JebVM, [state, callee]: [CallCollectState, any]) => {
    if (state.i >= state.argNodes.length) {
        pushCommand(vm, OP_call_invoke, {
            callee,
            args: state.values,
            tail: state.tail,
            source: state.source,
            name: state.name,
        });
        return;
    }
    const argNode = state.argNodes[state.i]!;
    state.i++;
    pushCommand(vm, OP_call_collect, state, callee);
    pushCommand(vm, OP_eval, argNode, false);
};

const OP_call_collect = (
    vm: JebVM,
    [state, callee]: [CallCollectState, any],
) => {
    state.values.push(popData(vm));
    pushCommand(vm, OP_call_step, state, callee);
};

/**
 * Invokes a callable value (a {@link Closure}, a {@link Block}, a host function,
 * or a {@link Continuation}) with already-evaluated arguments. Also used
 * internally wherever the runtime itself needs to call a value.
 */
export const OP_call_invoke = (vm: JebVM, { 0: call }: [call: CallArgs]) => {
    const { callee, args, tail, source, name } = call;
    if (callee instanceof Continuation) {
        callee.invoke(vm, args.length > 0 ? args[0] : undefined);
        return;
    }
    if (callee instanceof Block) {
        // Invoking a block evaluates its body, like a seq, in the
        // environment it captured. Blocks take no arguments; this is the
        // mechanism lazy parameters are built from.
        if (args.length > 0)
            throw new JEBError(
                `too many arguments: a block takes none, got ${args.length}`,
            );
        pushCommand(vm, OP_call_return, vm.currentEnv, tail, false);
        vm.currentEnv = callee.closureEnv;
        seqStart(vm, [...callee.body], true);
        return;
    }
    if (callee instanceof Closure) {
        const { params, rest } = callee;
        if (args.length < params.length)
            throw new JEBError(
                `too few arguments: expected ${params.length}, got ${args.length}`,
            );
        if (rest === undefined && args.length > params.length)
            throw new JEBError(
                `too many arguments: expected ${params.length}, got ${args.length}`,
            );
        const env = vm.createEnv(callee.env);
        params.forEach((param, i) => env.add(param, args[i]));
        if (rest !== undefined) env.add(rest, args.slice(params.length));
        const frameName = name ?? callee.name;
        if (frameName !== undefined)
            vm.pushTraceback(frameName, tail, source, StackEntryKind.FUNCTION);
        pushCommand(
            vm,
            OP_call_return,
            vm.currentEnv,
            tail,
            frameName !== undefined,
        );
        vm.currentEnv = env;
        seqStart(vm, [...callee.body], true);
        return;
    }
    if (typeof callee === "function") {
        if (name !== undefined)
            vm.pushTraceback(name, tail, source, StackEntryKind.FUNCTION);
        const result = wrapThrowToError(() =>
            (callee as HostFunction)(vm, ...args),
        );
        if (result instanceof Promise) {
            // The frame stays up while the VM is paused on the promise, and
            // is dropped when it resolves (on rejection it stays, so the
            // error's traceback includes this call).
            promisifyVM(
                vm,
                result.then((value) => {
                    if (name !== undefined) vm.popTraceback(false);
                    return value;
                }),
            );
            return;
        }
        // A synchronous host call is a leaf: no frames were pushed above
        // this one, so it can always be dropped directly. On a throw the
        // frame is left in place for the error's traceback.
        if (name !== undefined) vm.popTraceback(false);
        pushData(vm, result);
        return;
    }
    throw new JEBError(`value is not callable: ${typeof callee}`);
};

const OP_call_return = (
    vm: JebVM,
    {
        0: env,
        1: tail,
        2: framed,
    }: [env: JebVM["currentEnv"], tail: boolean, framed: boolean],
) => {
    const value = popData(vm);
    vm.currentEnv = env;
    // A tail call's frame is dropped by the return of the call it tail-
    // called from (popTraceback drops tail frames before its own).
    if (framed && !tail) vm.popTraceback();
    pushData(vm, value);
};

/** Calls a value and discards its result, leaving the data stack as it was. */
export const OP_call_value = (vm: JebVM, [callee, args]: [any, any[]]) => {
    pushCommand(vm, OP_discard);
    pushCommand(vm, OP_call_invoke, {
        callee,
        args,
        tail: false,
        source: undefined,
        name: undefined,
    });
};

const OP_discard = (vm: JebVM) => {
    popData(vm);
};

// MARK: let

interface LetState {
    binds: [name: Identifier, valueNode: any][];
    i: number;
    values: any[];
    body: any[];
    tail: boolean;
    outerEnv: JebVM["currentEnv"];
}

const OP_let_step = (vm: JebVM, [state]: [LetState]) => {
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

const OP_let_collect = (vm: JebVM, [state]: [LetState]) => {
    state.values.push(popData(vm));
    state.i++;
    pushCommand(vm, OP_let_step, state);
};

const OP_let_after = (vm: JebVM, [outerEnv]: [JebVM["currentEnv"]]) => {
    const value = popData(vm);
    vm.currentEnv = outerEnv;
    pushData(vm, value);
};

// MARK: definition and assignment

interface DefineArgs {
    name: Identifier;
    constant: boolean;
}

const OP_define_after = (vm: JebVM, [{ name, constant }]: [DefineArgs]) => {
    const value = popData(vm);
    if (value instanceof Closure && value.name === undefined) value.name = name;
    if (constant) vm.currentEnv.addConst(name, value);
    else vm.currentEnv.add(name, value);
    pushData(vm, NO_VALUE);
};

const OP_assign_after = (vm: JebVM, [{ name }]: [{ name: Identifier }]) => {
    const value = popData(vm);
    const scope = vm.currentEnv.set(name, value);
    if (scope === undefined)
        throw new JEBError(
            `cannot assign to undefined variable: ${String(name)}`,
        );
    if (scope === false)
        throw new JEBError(`cannot assign to constant: ${String(name)}`);
    pushData(vm, NO_VALUE);
};

// MARK: control opcodes' continuation steps

const OP_if_after = (
    vm: JebVM,
    {
        0: consequent,
        1: alternate,
        2: hasAlternate,
        3: tail,
    }: [consequent: any, alternate: any, hasAlternate: boolean, tail: boolean],
) => {
    const condition = popData(vm);
    // The core `if` branches on host truthiness. Converting a language's
    // values to booleans is that language's job (e.g. a Kuiper `bool` op),
    // not the core's.
    if (condition) pushCommand(vm, OP_eval, consequent, tail);
    else if (hasAlternate) pushCommand(vm, OP_eval, alternate, tail);
    else pushData(vm, NO_VALUE);
};

const OP_callcc_after = (
    vm: JebVM,
    [{ source }]: [{ source: SourceInfo<any> | undefined }],
) => {
    const callee = popData(vm);
    const continuation = vm.cc();
    pushCommand(vm, OP_call_invoke, {
        callee,
        args: [continuation],
        tail: false,
        source,
        name: undefined,
    });
};

const OP_eval_after = (
    vm: JebVM,
    [{ source, tail }]: [
        { source: SourceInfo<any> | undefined; tail: boolean },
    ],
) => {
    const code = popData(vm);
    if (!isIRNode(code)) throw syntaxError("eval: the value is not an IR node");
    pushCommand(vm, OP_eval, markExpansion(code, source), tail);
};

const OP_throw_value = (vm: JebVM) => {
    const value = popData(vm);
    if (value instanceof JEBError) throw value;
    throw new JEBError(String(value));
};

/**
 * The error-unwinding command the VM schedules when a {@link JEBError} is
 * thrown: runs each dynamic-wind exit handler it passes (with the error as its
 * argument) and finally parks the error on the VM for the host to see.
 */
export const OP_throw = (vm: JebVM, [err]: [JEBError]) => {
    while (vm.curDynamicWind.parent) {
        const dw = vm.curDynamicWind;
        vm.curDynamicWind = dw.parent!;
        dw.restore(vm);
        if (dw.handler?.exit) {
            pushCommand(vm, OP_throw, err);
            pushCommand(vm, OP_call_value, dw.handler.exit, [err]);
            return;
        }
    }
    vm.expansionStack.length = 0;
    vm.error = err;
};

// MARK: dynamic-wind

interface WindCollectState {
    nodes: any[];
    i: number;
    values: any[];
    source: SourceInfo<any> | undefined;
}

const OP_wind_step = (vm: JebVM, [state]: [WindCollectState]) => {
    if (state.i >= state.nodes.length) {
        const [enter, body, exit] = state.values as [any, any, any];
        const dw = vm.newDynamicWind();
        dw.setHandler({ enter, exit });
        vm.curDynamicWind = dw;
        pushCommand(vm, OP_wind_body, { dw, body, source: state.source });
        pushCommand(vm, OP_call_invoke, {
            callee: enter,
            args: [],
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

const OP_wind_collect = (vm: JebVM, [state]: [WindCollectState]) => {
    state.values.push(popData(vm));
    pushCommand(vm, OP_wind_step, state);
};

interface WindBodyArgs {
    dw: ReturnType<JebVM["newDynamicWind"]>;
    body: any;
    source: SourceInfo<any> | undefined;
}

const OP_wind_body = (vm: JebVM, [{ dw, body, source }]: [WindBodyArgs]) => {
    popData(vm); // the enter handler's result
    pushCommand(vm, OP_wind_exit, { dw, source, result: NO_VALUE });
    pushCommand(vm, OP_call_invoke, {
        callee: body,
        args: [],
        tail: false,
        source,
        name: undefined,
    });
};

interface WindExitArgs {
    dw: WindBodyArgs["dw"];
    source: SourceInfo<any> | undefined;
    result: any;
}

const OP_wind_exit = (vm: JebVM, [state]: [WindExitArgs]) => {
    state.result = popData(vm);
    pushCommand(vm, OP_wind_finish, state);
    pushCommand(vm, OP_call_invoke, {
        callee: state.dw.handler!.exit,
        args: [null],
        tail: false,
        source: state.source,
        name: undefined,
    });
};

const OP_wind_finish = (vm: JebVM, [state]: [WindExitArgs]) => {
    popData(vm); // the exit handler's result
    vm.curDynamicWind = state.dw.parent!;
    pushData(vm, state.result);
};

// MARK: the core opcode table

const checkArity = (ctx: OpcodeContext, min: number, max = min) => {
    const n = ctx.operands.length;
    if (n < min || n > max)
        throw syntaxError(
            `${ctx.op}: expected ${min === max ? min : `${min} to ${max}`} operands, got ${n}`,
        );
};

const checkName = (ctx: OpcodeContext, operand: any): Identifier => {
    if (!isIdentifier(operand))
        throw syntaxError(`${ctx.op}: expected a name operand`);
    return operand;
};

/**
 * Installs the core opcodes into the VM's opcode table. The core is
 * deliberately small -- data, sequencing, variables, conditionals, functions,
 * continuations, and evaluation. Everything semantic (operators, objects,
 * keyword arguments, collections) belongs to the layer above, which registers
 * its own opcodes and host functions.
 */
export const loadCoreOpcodes = (vm: JebVM) => {
    const defineOpcode = (name: string, handler: OpcodeHandler) =>
        vm.defineOpcode(name, handler)

    defineOpcode("const", (vm, ctx) => {
        checkArity(ctx, 1);
        // The operand is data: it is never evaluated, even if it is
        // node-shaped.
        pushData(vm, ctx.operands[0]);
    });

    defineOpcode("comment", (vm) => {
        // The operands are never evaluated, and the result is no value.
        pushData(vm, NO_VALUE);
    });

    defineOpcode("seq", (vm, ctx) => {
        seqStart(vm, ctx.operands, ctx.tail);
    });

    defineOpcode("var", (vm, ctx) => {
        checkArity(ctx, 1);
        const name = checkName(ctx, ctx.operands[0]);
        const result = vm.currentEnv.get(name);
        if (result.ok) {
            pushData(vm, result.data);
            return;
        }
        // no environment has the name: fall back to the host registry
        if (vm.hostRegistry.has(name)) {
            pushData(vm, vm.hostRegistry.get(name));
            return;
        }
        throw new JEBError(`no such variable: ${String(name)}`);
    });

    defineOpcode("define", (vm, ctx) => {
        checkArity(ctx, 2);
        const name = checkName(ctx, ctx.operands[0]);
        pushCommand(vm, OP_define_after, { name, constant: false });
        ctx.eval(ctx.operands[1]);
    });

    defineOpcode("define-const", (vm, ctx) => {
        checkArity(ctx, 2);
        const name = checkName(ctx, ctx.operands[0]);
        pushCommand(vm, OP_define_after, { name, constant: true });
        ctx.eval(ctx.operands[1]);
    });

    defineOpcode("assign", (vm, ctx) => {
        checkArity(ctx, 2);
        const name = checkName(ctx, ctx.operands[0]);
        pushCommand(vm, OP_assign_after, { name });
        ctx.eval(ctx.operands[1]);
    });

    defineOpcode("let", (vm, ctx) => {
        const binds: LetState["binds"] = [];
        let i = 0;
        while (
            i < ctx.operands.length &&
            isIRNode(ctx.operands[i]) &&
            ctx.operands[i]![0] === "bind"
        ) {
            const bind = ctx.operands[i]!;
            if (bind.length !== 4)
                throw syntaxError("bind: expected a name and a value node");
            binds.push([checkName(ctx, bind[2]), bind[3]]);
            i++;
        }
        pushCommand(vm, OP_let_step, {
            binds,
            i: 0,
            values: [],
            body: ctx.operands.slice(i),
            tail: ctx.tail,
            outerEnv: vm.currentEnv,
        } satisfies LetState);
    });

    defineOpcode("bind", (vm, ctx) => {
        throw syntaxError("bind: only meaningful as an operand of let");
    });

    defineOpcode("lambda", (vm, ctx) => {
        if (ctx.operands.length < 1)
            throw syntaxError("lambda: expected a parameter list");
        const paramsData = ctx.operands[0];
        if (!Array.isArray(paramsData))
            throw syntaxError("lambda: parameters must be an array of names");
        const params: Identifier[] = [];
        let rest: Identifier | undefined;
        paramsData.forEach((param, i) => {
            if (typeof param === "string" && param.startsWith("...")) {
                if (i !== paramsData.length - 1)
                    throw syntaxError(
                        "lambda: a rest parameter must come last",
                    );
                rest = param.slice(3);
                if (!rest)
                    throw syntaxError("lambda: rest parameter needs a name");
            } else if (isIdentifier(param)) params.push(param);
            else throw syntaxError("lambda: parameters must be names");
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
            throw syntaxError("call: expected at least a callee node");
        const calleeNode = ctx.operands[0];
        const state: CallCollectState = {
            argNodes: ctx.operands.slice(1),
            i: 0,
            values: [],
            tail: ctx.tail,
            source: ctx.source,
            name:
                isIRNode(calleeNode) && calleeNode[0] === "var"
                    ? calleeNode[2]
                    : undefined,
        };
        pushCommand(vm, OP_call_start, state);
        ctx.eval(calleeNode);
    });

    defineOpcode("if", (vm, ctx) => {
        checkArity(ctx, 2, 3);
        pushCommand(
            vm,
            OP_if_after,
            ctx.operands[1],
            ctx.operands[2],
            ctx.operands.length > 2,
            ctx.tail,
        );
        ctx.eval(ctx.operands[0]);
    });

    defineOpcode("callcc", (vm, ctx) => {
        checkArity(ctx, 1);
        pushCommand(vm, OP_callcc_after, { source: ctx.source });
        ctx.eval(ctx.operands[0]);
    });

    defineOpcode("dynamic-wind", (vm, ctx) => {
        checkArity(ctx, 3);
        pushCommand(vm, OP_wind_step, {
            nodes: ctx.operands,
            i: 0,
            values: [],
            source: ctx.source,
        } satisfies WindCollectState);
    });

    defineOpcode("eval", (vm, ctx) => {
        checkArity(ctx, 1);
        pushCommand(vm, OP_eval_after, {
            source: ctx.source,
            tail: ctx.tail,
        });
        ctx.eval(ctx.operands[0]);
    });

    defineOpcode("throw", (vm, ctx) => {
        checkArity(ctx, 1);
        pushCommand(vm, OP_throw_value);
        ctx.eval(ctx.operands[0]);
    });
};

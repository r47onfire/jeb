/**
 * Testing utilities for JEB: a simple Lisp IR node representation, plus a
 * ready-made test VM and run helpers.
 *
 * The core (`index`) is representation-agnostic: it never sees a node shape,
 * only the layer's hooks. This module is the concrete side -- the `IRNode` type
 * and its helpers, the node walker that implements {@link JebVM.evalNode} for IR
 * nodes, the opcode table for the core language, and {@link TestVM}.
 */
import { isArray } from "lib0/array";
import { Block } from "./block";
import { Closure } from "./closure";
import { Continuation } from "./continuation";
import { JEBError, promisifyVM, wrapThrowToError } from "./errors";
import { SourceInfo } from "./ir";
import {
    CallArgs,
    evalCallArgs,
    letStart,
    OP_assign_after,
    OP_call_return,
    OP_call_start,
    OP_callcc_after,
    OP_define_after,
    OP_eval,
    OP_if_after,
    OP_throw_value,
    OpcodeContext,
    OpcodeHandler,
    seqStart,
    windStart,
} from "./opcodes";
import { Identifier, isIdentifier } from "./utils";
import { JebVM, popData, pushCommand, pushData, StackEntryKind } from "./vm";

// MARK: the Lisp IR

/**
 * One IR node: a Lisp-form array whose first element is the opcode name, whose
 * second element is the node's {@link SourceInfo} (or a bare span, or
 * `undefined` when no source is known), and whose remaining elements are the
 * opcode's operands.
 *
 * Every array in code position is an IR node; literal arrays are data and only
 * ever appear as operands (e.g. of `const`), never in code position. Nodes are
 * walked pre-order: the opcode handler receives its operands unevaluated and
 * decides which of them to evaluate, skip, or evaluate repeatedly.
 */
export type TestIRNode = [
    op: string,
    source: string | SourceInfo<string>,
    ...operands: any[],
];

/** Whether the value is shaped like an {@link TestIRNode}. */
export const isIRNode = (x: unknown): x is TestIRNode =>
    isArray(x) && typeof x[0] === "string";

/**
 * Normalizes the source slot of an {@link TestIRNode} (or a standalone source)
 * to a {@link SourceInfo}: a bare span is wrapped, a `SourceInfo` is passed
 * through, and `undefined`/`null` stays `undefined`.
 */
export const normalizeSource = <S>(
    source: SourceInfo<S> | S | undefined | null,
): SourceInfo<S> | undefined => {
    if (source === undefined || source === null) return undefined;
    if (
        typeof source === "object" &&
        ("span" in source || "expandedFrom" in source)
    )
        return source as SourceInfo<S>;
    return { span: source as S };
};

/** The normalized {@link SourceInfo} of an {@link TestIRNode}, if it has one. */
export const nodeSource = (node: TestIRNode): SourceInfo<string> | undefined =>
    normalizeSource(node[1]);

/**
 * Builds an {@link TestIRNode}. `source` may be a {@link SourceInfo}, a bare span
 * in the compiler's span type, or `undefined`.
 */
export const op = (
    name: string,
    source: SourceInfo<string> | string | undefined,
    ...operands: any[]
): TestIRNode => [name, source, ...operands] as TestIRNode;

const appendChain = (
    link: SourceInfo<string>,
    tail: SourceInfo<string>,
): SourceInfo<string> =>
    link.expandedFrom === undefined
        ? { ...link, expandedFrom: tail }
        : { ...link, expandedFrom: appendChain(link.expandedFrom, tail) };

/**
 * Marks an IR node as the result of expanding the macro invocation at
 * `invocation` (the invocation node's own source). Returns a copy of the node
 * with its source's `expandedFrom` extended by the invocation source; the
 * node's own span is left alone. Only the root of the expansion is stamped --
 * nested nodes keep the sources they were built with, and the evaluator pushes
 * the root's expansion link as context while the subtree runs (see
 * `expansionStack` on the VM).
 */
export const markExpansion = (
    node: TestIRNode,
    invocation: SourceInfo<string> | undefined,
): TestIRNode => {
    if (invocation === undefined) return node;
    const old = nodeSource(node);
    const stamped = [...node] as TestIRNode;
    stamped[1] = {
        span: old?.span,
        expandedFrom: old?.expandedFrom
            ? appendChain(old.expandedFrom, invocation)
            : invocation,
    };
    return stamped;
};

/** A name usable as an operand: a variable name or a parameter name. */
export type NameOperand = Identifier;

// MARK: evaluating IR nodes

const OP_pop_expansion = (vm: JebVM<any, any, any>) => {
    const value = popData(vm);
    vm.expansionStack.pop();
    pushData(vm, value);
};

/**
 * The {@link JebVM.evalNode} implementation for IR nodes: dispatches the node to
 * its opcode handler with a context whose `eval` schedules child nodes,
 * stamping expansion provenance the way the core expects (an expanded node's
 * source link sits on the VM's expansion stack while its subtree runs).
 */
export const evalIRNode = (
    vm: JebVM<any, string, TestIRNode>,
    node: TestIRNode,
    tail: boolean,
) => {
    if (!isIRNode(node))
        throw vm.createError(`cannot evaluate a non-node: ${String(node)}`);
    const opName = node[0]!;
    const handler = vm.opcodes[opName];
    if (!handler) throw vm.createError(`unknown opcode: ${opName}`);
    const source = nodeSource(node);
    const ctx: OpcodeContext<string, TestIRNode> = {
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

// MARK: opcode-table helpers

const checkArity = (
    vm: JebVM<any, any, any>,
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
    vm: JebVM<any, any, any>,
    ctx: OpcodeContext,
    operand: any,
): Identifier => {
    if (!isIdentifier(operand))
        throw vm.createError(`${ctx.op}: expected a name operand`);
    return operand;
};

const OP_eval_after = (
    vm: JebVM<any, string, TestIRNode>,
    [source, tail]: [source: SourceInfo<string> | undefined, tail: boolean],
) => {
    const code = popData(vm);
    if (!isIRNode(code))
        throw vm.createError("eval: the value is not an IR node");
    pushCommand(vm, OP_eval, markExpansion(code, source), tail);
};

interface WindCollectState {
    nodes: TestIRNode[];
    i: number;
    values: any[];
    source: SourceInfo<string> | undefined;
}

/**
 * Collects a dynamic-wind's three handler values, then hands them to
 * {@link windStart}.
 */
const OP_wind_collect_step = (
    vm: JebVM<any, string, TestIRNode>,
    [state]: [state: WindCollectState],
) => {
    if (state.i >= state.nodes.length) {
        const [enter, body, exit] = state.values as [any, any, any];
        windStart(vm, enter, body, exit, state.source);
        return;
    }
    const node = state.nodes[state.i]!;
    pushCommand(vm, OP_wind_collect_collect, { ...state, i: state.i + 1 });
    pushCommand(vm, OP_eval, node, false);
};

const OP_wind_collect_collect = (
    vm: JebVM<any, string, TestIRNode>,
    [state]: [state: WindCollectState],
) => {
    pushCommand(vm, OP_wind_collect_step, {
        ...state,
        values: [...state.values, popData(vm)],
    });
};

// MARK: the core opcode table

/**
 * Installs the Lisp IR's opcode table into a VM: data, sequencing, variables,
 * conditionals, functions, continuations, and evaluation. The handlers are
 * deliberately thin -- each parses its operands and hands the pieces to the
 * core's representation-agnostic state machines ({@link seqStart},
 * {@link letStart}, {@link windStart}, `OP_if_after`, and friends) or to the
 * VM's hooks (variables go through {@link JebVM.getVariable} and its
 * siblings).
 */
export const loadCoreOpcodes = (vm: JebVM<any, string, TestIRNode>) => {
    const defineOpcode = (
        name: string,
        handler: OpcodeHandler<any, string, TestIRNode>,
    ) => vm.defineOpcode(name, handler);

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
        pushData(vm, vm.getVariable(checkName(vm, ctx, ctx.operands[0])));
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
        const binds: [name: Identifier, valueNode: TestIRNode][] = [];
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
            binds.push([checkName(vm, ctx, bind[2]), bind[3]!]);
        }
        letStart(vm, binds, ctx.operands.slice(i), ctx.tail);
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
        const state = {
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
        pushCommand(vm, OP_wind_collect_step, {
            nodes: ctx.operands,
            i: 0,
            values: [],
            source: ctx.source,
        });
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

// MARK: the test VM

/** The test layer's no-value sentinel: what {@link TestVM.noValue} returns. */
export const NO_VALUE = Symbol("NO_VALUE");

/** A host (Javascript) function callable from code through `call`. */
export type HostFunction = (
    vm: JebVM<any, string, TestIRNode>,
    ...args: any[]
) => any;

/**
 * A working VM over JS values and Lisp-IR code, implementing every hook the
 * core leaves abstract in the simplest reasonable way: None is `null`, the
 * no-value sentinel is {@link NO_VALUE}, errors are {@link JEBError}s with the
 * traceback attached at creation, truthiness is the host's, and variables live
 * in the core's environments with a fallback to a host registry (for functions
 * and values the host provides). Calling is eager -- closures and host
 * functions evaluate all their arguments; blocks evaluate none -- which is the
 * semantics the core's own tests are written against, and a reasonable starting
 * point for a layer's own VM.
 */
export class TestVM extends JebVM<any, string, TestIRNode> {
    /** Host-provided values and functions, by name. Not an environment. */
    readonly hostRegistry = new Map<Identifier, any>();
    constructor() {
        super();
        loadCoreOpcodes(this);
    }
    // The value and error hooks.
    override noneValue() {
        return null;
    }
    override noValue() {
        return NO_VALUE;
    }
    override createError(message: string) {
        return new JEBError(message, {}, {}, this.tracebackArray());
    }
    override isError(value: unknown) {
        return value instanceof JEBError;
    }
    // The code hooks: IR nodes execute through the Lisp-IR walker.
    override evalNode(node: TestIRNode, tail: boolean) {
        evalIRNode(this, node, tail);
    }
    override getLocation(node: TestIRNode) {
        return nodeSource(node)?.span;
    }
    // The test VM's values are plain JS values, so
    // boolification and truthiness is literally the identity function.
    override boolify(value: any) {
        pushData(this, value);
    }
    override isTruthy(value: any) {
        return !!value;
    }
    override booleanValue(value: boolean) {
        return value;
    }
    // The core's environments first, then the host registry (reads only
    // -- the registry is not a scope, so defining and assigning never see it).
    override getVariable(name: Identifier) {
        const result = this.currentEnv.get(name);
        if (result.ok) return result.data;
        if (this.hostRegistry.has(name)) return this.hostRegistry.get(name);
        throw this.createError(`no such variable: ${String(name)}`);
    }
    override defineVariable(name: Identifier, value: any, constant: boolean) {
        if (constant) this.currentEnv.addConst(name, value);
        else this.currentEnv.add(name, value);
    }
    override assignVariable(name: Identifier, value: any) {
        const scope = this.currentEnv.set(name, value);
        if (scope === undefined)
            throw this.createError(
                `cannot assign to undefined variable: ${String(name)}`,
            );
        if (scope === false)
            throw this.createError(
                `cannot assign to constant: ${String(name)}`,
            );
    }
    /** Registers a host (Javascript) function in the {@link hostRegistry}. */
    defineHostFunction(name: Identifier, fn: HostFunction) {
        if (this.hostRegistry.has(name))
            throw new Error(
                `host function ${String(name)} is already registered`,
            );
        this.hostRegistry.set(name, fn);
    }
    /** Registers a host value in the {@link hostRegistry}. */
    defineValue(name: Identifier, value: any) {
        if (this.hostRegistry.has(name))
            throw new Error(`host value ${String(name)} is already registered`);
        this.hostRegistry.set(name, value);
    }
    override dispatchCall(call: CallArgs<any, string, TestIRNode>) {
        const { callee, args } = call;
        if (callee instanceof Continuation) {
            // a continuation takes at most one argument: the value it
            // resumes with (extra arguments are evaluated and ignored)
            evalCallArgs(this, call, (_vm, values) =>
                callee.invoke(this, values[0]),
            );
            return;
        }
        if (callee instanceof Block) {
            // Invoking a block evaluates its body, like a seq, in the
            // environment it captured. Blocks take no arguments -- and their
            // would-be arguments are never evaluated; this is the mechanism
            // lazy parameters are built from.
            if (args.length > 0)
                throw this.createError(
                    `too many arguments: a block takes none, got ${args.length}`,
                );
            pushCommand(this, OP_call_return, this.currentEnv, false);
            this.currentEnv = callee.closureEnv;
            seqStart(this, [...callee.body], true);
            return;
        }
        if (callee instanceof Closure || typeof callee === "function") {
            // this layer's closures and host functions are eager: evaluate
            // every argument (in the call site's environment), then call
            evalCallArgs(this, call, (_vm, values) =>
                this.dispatchEvaluated(call, values),
            );
            return;
        }
        throw this.createError(`value is not callable: ${typeof callee}`);
    }
    /** The closure/host-function half of dispatch, with evaluated arguments. */
    private dispatchEvaluated(
        { callee, tail, source, name }: CallArgs<any, string, TestIRNode>,
        args: any[],
    ) {
        if (callee instanceof Closure) {
            const { params, rest } = callee;
            if (args.length < params.length)
                throw this.createError(
                    `too few arguments: expected ${params.length}, got ${args.length}`,
                );
            if (rest === undefined && args.length > params.length)
                throw this.createError(
                    `too many arguments: expected ${params.length}, got ${args.length}`,
                );
            const env = this.createEnv(callee.env);
            params.forEach((param, i) => env.add(param, args[i]));
            if (rest !== undefined) env.add(rest, args.slice(params.length));
            const frameName = name ?? callee.name;
            if (frameName !== undefined)
                this.pushTraceback(
                    frameName,
                    tail,
                    source,
                    StackEntryKind.FUNCTION,
                );
            pushCommand(
                this,
                OP_call_return,
                this.currentEnv,
                !tail && frameName !== undefined,
            );
            this.currentEnv = env;
            seqStart(this, [...callee.body], true);
            return;
        }
        // host function
        if (name !== undefined)
            this.pushTraceback(name, tail, source, StackEntryKind.FUNCTION);
        const result = wrapThrowToError(this, () =>
            (callee as HostFunction)(this, ...args),
        );
        if (result instanceof Promise) {
            // The frame stays up while the VM is paused on the promise,
            // and is dropped when it resolves (on rejection it stays, so
            // the error's traceback includes this call).
            promisifyVM(
                this,
                result.then((value) => {
                    if (name !== undefined) this.popTraceback(false);
                    return value;
                }),
            );
            return;
        }
        // A synchronous host call is a leaf: no frames were pushed above
        // this one, so it can always be dropped directly. On a throw the
        // frame is left in place for the error's traceback.
        if (name !== undefined) this.popTraceback(false);
        pushData(this, result);
    }
}

// MARK: run helpers

/**
 * Drives a VM to completion synchronously and returns its result (the top of
 * the data stack). The error that stopped the VM, if any, is thrown.
 */
export const run = <D = any, S = any, C = any>(vm: JebVM<D, S, C>, code: C) => {
    vm.start(code);
    while (!vm.done && !vm.error) vm.step();
    if (vm.error) throw vm.error;
    return popData(vm);
};

/** Like {@link run}, but awaits the VM whenever it pauses on a promise. */
export const runAsync = async <D = any, S = any, C = any>(
    vm: JebVM<D, S, C>,
    code: C,
) => {
    vm.start(code);
    while (!vm.done && !vm.error) {
        if (vm.paused) await vm.awaiting;
        else vm.step();
    }
    if (vm.error) throw vm.error;
    return popData(vm);
};

/**
 * Builds a test-registration helper (the `testTest` wrapper) bound to a VM
 * factory: each registered test gets a fresh VM and its captured output, and a
 * VM error is printed with its traceback before the test fails. `testfun` is
 * the test framework's own registration function (e.g. `test` from `bun:test`),
 * passed in so this module stays framework-free.
 */
export const makeTestRun =
    <V extends JebVM<any, any, any>>(
        createVM: () => { vm: V; out: string[] },
    ) =>
    <U>(
        testfun: (name: string, body: () => U) => void,
        name: string,
        testBody: (vm: V, out: string[]) => U,
    ) => {
        const { vm, out } = createVM();
        testfun(name, () => {
            try {
                return testBody(vm, out);
            } catch (e) {
                console.error("Test error caught!");
                console.error(String(e));
                console.error((e as any).stack);
                throw e;
            }
        });
    };

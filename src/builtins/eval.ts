import { isArray } from "lib0/array";
import { JEBAuditEvents } from "../auditHookTypes";
import { Block } from "../block";
import { Fun, JSFun } from "../callable";
import { Continuation } from "../continuation";
import { define, makeJSFun, makeOpcode, NOTHING } from "../define";
import { OP_doargs } from "../doargs";
import { Env } from "../env";
import { ErrnoCode } from "../errno";
import {
    checkNothingOrPush,
    JEBError,
    Location,
    wrapThrowToError,
} from "../errors";
import {
    AccessType,
    ApplyMetadata,
    Reference,
    SetFlags,
} from "../reference";
import {
    CallableSignature,
    createSignature,
    Laziness,
    LonghandArgument,
    Rest,
} from "../signature";
import { theTypeName, typecheck, typeOf, withType } from "../typecheck";
import { Identifier } from "../utils";
import {
    Command,
    JebVM,
    peekData,
    popData,
    popNData,
    pushCommand,
    pushData,
    StackEntryKind,
} from "../vm";
import {
    EmptyArg,
    KeywordArg,
    MacroWrapper,
    NullHole,
    OptionArg,
    SplatArg,
} from "../wrapper";
import { OP_continuation_invoke, OP_fun_invoke } from "./callables";
import { ObjectPropertyReference, VariableReference } from "./reference";
import { OP_unwrap } from "./unwrap";
import { B_local, OP_assign_internal, OP_block_invoke } from "./variables";

export const OP_audit = makeOpcode(
    "audit",
    <T extends keyof JEBAuditEvents>(
        vm: JebVM,
        args: [name: T, arg: JEBAuditEvents[T]],
    ) => {
        vm.emit(...args);
    },
    `.imm name arg
..param {keyof JEBAuditEvents} name
..param {any} arg
. Raises an auditing event with the given argument.`,
);

export const B_audit = makeJSFun(
    "audit",
    ["event", "param"],
    (args, vm) =>
        vm.emit(withType(args.event, ["string"], "event", args), args.param),
    `.func (audit event param)
..param {keyof JEBAuditEvents} event
..param {any} param
. Raises an auditing event with the given argument.`,
);

// MARK: op: traceback push/pop
export const OP_tbPop = makeOpcode(
    "tb_pop",
    (vm) => vm.popTraceback(),
    `.imm
.sed --
. Pops the top of the traceback stack, including all tailcall entries if there are some.`,
);
export const OP_tbPush = makeOpcode(
    "tb_push",
    (
        vm: JebVM,
        {
            0: func,
            1: location,
            2: kind,
            3: tail,
        }: [
            f: Identifier | undefined,
            Location | undefined,
            kind: StackEntryKind,
            tail?: boolean,
        ],
    ) => vm.pushTraceback(func, tail ?? false, location, kind),
    `.imm function location tailcall
..param {string} function
..param {Location} location
..param {boolean} [tailcall=false]
. Pushes the function to the traceback stack.`,
);

// MARK: op: stack shuffle
export const OP_shuffle = makeOpcode(
    "shuffle",
    (vm: JebVM, { 0: n, 1: indices }: [number, number[]]) => {
        const items = popNData(vm, n),
            len = indices.length;
        for (var i = 0; i < len; i++) {
            pushData(vm, items[indices[i]!]!);
        }
    },
    `.imm count indices
..param {number} count
..param {number[]} indices
. Pops \`count\` items off the stack, and then pushes the items back on in the order defined by \`indices\`.
Examples:
* \`N/[0, 1, 2, 3, ..., N-1]\` = identity
* \`2/[1, 0]\` = swap
* \`1/[]\` = drop
* \`1/[0, 0]\` = dup
* \`N/[1, 2, 3, 4, ..., N-1, 0]\` = N-tuck`,
);

// MARK: eval
export const OP_eval = makeOpcode(
    "eval",
    (
        vm: JebVM,
        { 0: location, 1: tail }: [Location | undefined, tail?: boolean],
    ) => {
        const code = popData(vm);
        if (isArray(code)) {
            if (code.length === 0) {
                throw new JEBError(
                    ErrnoCode.EINVAL,
                    "can't evaluate empty array",
                    {},
                    { return: vm.cc() },
                );
            }
            arrayEval(vm, code, tail ?? false, location);
        } else if (
            code instanceof Fun ||
            code instanceof JSFun ||
            code instanceof Block
        ) {
            // Functions and implicit blocks evaluate to themselves.
            pushData(vm, code);
        } else if (typeof code === "object") {
            if (code === null) {
                pushData(vm, null);
                return;
            }
            // Evaluate all the properties, then reassemble the object with
            // the same set of keys with the evaluated values.
            const target = {};
            pushData(vm, target);
            const keys = Reflect.ownKeys(code),
                len = keys.length;
            for (var i = 0; i < len; i++) {
                pushData(
                    vm,
                    new ObjectPropertyReference(
                        AccessType.PROPERTY,
                        target,
                        keys[i]!,
                    ),
                );
                pushData(vm, code[keys[i]!]);
                pushCommand(vm, OP_shuffle, 1, []);
                pushCommand(vm, OP_assign, true);
                pushCommand(vm, OP_shuffle, 2, [1, 0]);
                pushCommand(vm, OP_eval, location);
            }
        } else {
            pushData(vm, code);
        }
    },
    `.imm location tailcall
..param {Location} location
..param {boolean?} [tailcall=false]
.sed value -- evaled
. Evaluates the top item of the stack. An array gets interpreted as a call and passed to [[jeb:apply]], an object has all its properties evaluated and reassembled, and anything else is treated as a literal and left as-is.`,
);
export const B_eval = makeJSFun(
    "eval",
    ["arg"],
    ({ arg }, vm, location) => {
        pushData(vm, arg);
        pushCommand(vm, OP_eval, location);
        return NOTHING;
    },
    `.func (eval arg)
..param {code} arg
.returns {any}
. Evaluates \`arg\` in the current environment.`,
);

export const B_macro_wrap = makeJSFun(
    "macro",
    ["code"],
    ({ code }) => new MacroWrapper(code),
    `.func (macro code)
..param {code} code
.pure
. Wraps the code in a special object that causes it to be evaluated using [[eval]] in the scope of where it was used and the result of the evaluation used in place of the actual code object.
This can be used to create an unhygienic syntactic macro by returning the wrapper immediately.`,
);

export const B_object = makeJSFun(
    "object",
    [[["splat", "keyword"], 0, "pairs"]],
    ({ pairs }) => {
        const out = {} as Record<PropertyKey, any>;
        for (var i = 0; i < pairs.length; i++) {
            const arg = pairs[i];
            if (arg instanceof SplatArg) {
                if (arg.isKeyword) {
                    Object.assign(out, arg.obj);
                } else {
                    throw new JEBError(
                        ErrnoCode.EPANIC,
                        "positional splat to 'object' not implemented yet",
                    );
                }
            } else if (arg instanceof KeywordArg) {
                out[arg.name] = arg.obj;
            } else {
                if (i + 1 >= pairs.length)
                    throw new JEBError(
                        ErrnoCode.ESYNTAX,
                        "object should have an even number of positional arguments",
                    );
                out[arg as PropertyKey] = pairs[i + 1];
                i++;
            }
        }
        return out;
    },
    `.func (object key value [key2 value2]...)
..param {PropertyKey} key - Key for the next value
..param {any} value
..returns {Record}
..throws ESYNTAX - if there is an odd number of arguments
. Returns a new object with dynamically-evaluated keys.`,
);

const arrayEval = (
    vm: JebVM,
    code: any[],
    tail: boolean,
    location: Location | undefined,
) => {
    pushCommand(vm, OP_apply, code.slice(1), location, tail);
    pushCommand(vm, OP_unwrap, ["hole"]);
    pushCommand(vm, OP_eval, location);
    pushData(vm, code[0]);
};
// MARK: apply
/** The signature calls of the null-chaining hole are bound against. */
export const nullchainSignature = createSignature([[false, 0, "args"]]);
/**
 * The `apply` implementation for the hole: discard the arguments without
 * evaluating them, and return the hole itself.
 */
export const OP_hole_call = makeOpcode(
    null,
    (vm: JebVM, { 0: hole }: [NullHole]) => {
        popData(vm);
        pushData(vm, hole);
    },
    null,
);
/**
 * Describes a callable value: the metadata the apply opcode needs to set up
 * the call (the traceback name, the parameter signature the arguments are
 * bound against, and the closure environment for defaults), or `undefined`
 * if the value cannot be called at all.
 */
export const describeCallable = (
    vm: JebVM,
    func: any,
): ApplyMetadata | undefined => {
    if (typeof func === "string" || typeof func === "symbol") {
        // A string in head position is shorthand for looking up the variable
        // of the same name and calling that instead; it is described by the
        // single quoted rest parameter the trampoline re-applies with.
        return { name: undefined, signature: ALL_UNDERSCORE_QUOTED };
    }
    if (func instanceof JSFun) return func;
    if (func instanceof Fun) {
        return {
            name: func.isImplicit ? undefined : (func.name ?? "[anonymous]"),
            signature: func.signature,
            closureEnv: func.closureEnv,
        };
    }
    if (func instanceof Block) {
        return {
            name: undefined,
            signature: [
                {
                    name: "_",
                    required: false,
                    defaultExpr: {},
                    lazy: Laziness.NONE,
                    flags: [],
                    rest: Rest.NONE,
                    options: {},
                },
            ],
            closureEnv: func.closureEnv,
        };
    }
    if (func instanceof Continuation) {
        return {
            name: "<continuation>",
            signature: createSignature(["value"]),
        };
    }
    if (func instanceof NullHole) {
        // Calling the hole discards the arguments without evaluating them.
        return { name: undefined, signature: nullchainSignature };
    }
    if (typeof func === "function") {
        // A host (Javascript) function, called through the FFI.
        return {
            name: `[JS function ${func.name || "<no name>"}]`,
            signature: ALL_UNDERSCORE_NORMAL,
        };
    }
    return undefined;
};
/**
 * Schedules the implementation of a call to a value {@link describeCallable}
 * described: pushes the opcodes that run the callee's body once the
 * arguments object (produced by the `doargs` opcode the apply opcode pushes
 * right after this) is on the stack.
 */
const runCallable = (
    vm: JebVM,
    func: any,
    tail: boolean,
    location: Location | undefined,
) => {
    if (typeof func === "string" || typeof func === "symbol") {
        pushCommand(vm, OP_apply_id_trampoline, tail, location);
        pushCommand(vm, OP_tbPop);
        pushCommand(vm, OP_unwrap, ["hole"]);
        pushCommand(vm, OP_get, false);
        pushCommand(vm, OP_shuffle, 2, [1, 0]);
        pushCommand(vm, OP_tbPush, undefined, location, StackEntryKind.NONE);
        pushData(
            vm,
            new VariableReference(AccessType.FUNCTION, vm.currentEnv, func),
        );
    } else if (func instanceof JSFun) {
        pushCommand(vm, OP_JSFun_invoke, func, location);
    } else if (func instanceof Fun) {
        pushCommand(vm, OP_fun_invoke, func, tail);
    } else if (func instanceof Block) {
        pushCommand(vm, OP_block_invoke, func, tail);
    } else if (func instanceof Continuation) {
        pushCommand(vm, OP_continuation_invoke, func);
    } else if (func instanceof NullHole) {
        pushCommand(vm, OP_hole_call, func);
    } else {
        pushCommand(vm, OP_ffi_invoke, func);
    }
};
export const OP_apply = makeOpcode(
    "apply",
    (
        vm: JebVM,
        {
            0: argv,
            1: location,
            2: tail,
            3: noEval,
        }: [
            any[],
            location?: Location,
            tail?: boolean,
            noEval?: boolean | boolean[],
        ],
    ) => {
        const func = popData(vm);
        const metadata = describeCallable(vm, func);
        if (!metadata) {
            throw new JEBError(
                ErrnoCode.EINVAL,
                `can't call ${theTypeName(typeOf(func))}`,
                {},
                { return: vm.cc() },
            );
        }
        const { name, signature, closureEnv } = metadata;
        if (name && !tail) pushCommand(vm, OP_tbPop);
        runCallable(vm, func, tail ?? false, location);
        if (name)
            pushCommand(
                vm,
                OP_tbPush,
                name,
                location,
                StackEntryKind.FUNCTION,
                tail,
            );
        pushCommand(
            vm,
            OP_doargs,
            signature,
            closureEnv,
            noEval ?? false,
            name,
        );
        pushData(vm, argv);
    },
    `.imm expressions location tailcall noEval
..param {code[]} expressions
..param {Location?} location
..param {boolean?} [tailcall=false]
..param {boolean | boolean[]?} noEval
.sed functor -- result
.throws EINVAL - when the object is not callable
.throws ERANGE - when the argument count is wrong
. Pops the top value from the stack and calls it with the provided arguments.
The arguments expressions are expected to be unevaluated, and the signature of the thing being called will determine whether the argument given is evaluated or not. \`noEval\` says which arguments are already-computed values instead: either a single boolean, applying to all the arguments, or an array of booleans, one per argument.`,
);
/**
 * Partially applies a callable to its first parameter: returns a callable that
 * calls `callee` with `value` filled in for that parameter. The callee's
 * signature and closure environment come from {@link describeCallable}, so
 * how the callee is implemented doesn't matter.
 */
export const curry = (vm: JebVM, callee: any, value: any) => {
    const metadata = describeCallable(vm, callee);
    if (!metadata)
        throw new JEBError(
            ErrnoCode.EINVAL,
            `can't call ${theTypeName(typeOf(callee))}`,
        );
    const { name, signature, closureEnv } = metadata;
    const first = signature[0];
    if (!first) return callee;
    if (first.rest === Rest.KEYWORD)
        throw new JEBError(
            ErrnoCode.EINVAL,
            "can't curry a function that accepts only keyword arguments",
        );
    const calleeName = Symbol.for("__callee__");
    const forward = (p: LonghandArgument<any, any>): any =>
        p.rest === Rest.POSITIONAL
            ? [B_splat, [B_local, p.name]]
            : p.rest === Rest.KEYWORD
              ? [B_splat, [B_local, p.name], true]
              : [B_local, p.name];
    return new Fun(
        false,
        name,
        signature.slice(1),
        new Block(
            new Env(
                { [first.name]: value, [calleeName]: callee },
                closureEnv ? [closureEnv] : [],
            ),
            [
                [
                    [B_local, calleeName],
                    [B_local, first.name],
                    ...(first.rest ? signature : signature.slice(1)).map(
                        forward,
                    ),
                ],
            ],
        ),
        "",
    );
};
export const B_atLocation = makeJSFun(
    "at",
    [
        [true, "pos"],
        [true, "expr"],
    ],
    ({ pos, expr }, vm) => {
        typecheck(pos, [Array], "pos");
        // Remove self frame from here
        vm.popTraceback(false); // don't drop tail call, just in case this is in tail position
        // The value this form produces is located at pos, even if evaluating
        // expr makes no call at all (e.g. it is a constant): record that in
        // the last-call slot, so a consumer resuming after the evaluation
        // (such as argument binding) can still attribute the value to pos.
        // If expr does make a call, that call's frame overwrites this when
        // it pops, and it carries pos as its own location anyway.
        vm.lastCall = {
            name: undefined,
            location: pos as Location,
            kind: StackEntryKind.NONE,
        };
        vm.popCommand(); // This will be the tb_pop pushed by apply above
        pushCommand(vm, OP_eval, pos as Location);
        return expr;
    },
    `.macro (at location expr)
..param {opaque-id} location
..param {code} expr
. Equivalent to \`expr\` as a normal [[eval]]uation, but inserts the metadata of \`location\` into the stack frame to identify the call site itself instead of just the thing that was called. \`at\` frames never appear in tracebacks.`,
);
export const B_splat = makeJSFun(
    "splat",
    ["value", ["kw", false]],
    (args) =>
        new SplatArg(args.value, withType(args.kw, ["boolean"], "kw", args)),
    `.func (splat arg kw)
..param {any[] | object} arg - iterable or object to unpack
..param {boolean?} [kw=false] - whether to unpack into positional or keyword arguments
.pure
. Causes the value to unpack into keyword or positional arguments instead of being passed as a single value.`,
);
export const B_keyword = makeJSFun(
    "kw",
    ["name", "value"],
    (args) =>
        new KeywordArg(
            args.value,
            withType(args.name, ["string"], "name", args),
        ),
    `.func (kw name value)
..param {string} name - name of keyword arg to unpack into
..param {any} value
.pure
. Redirects the argument into a particular named argument slot.`,
);

export const B_blank = makeJSFun(
    "blank",
    [],
    () => new EmptyArg(),
    `.func (blank)
.pure
. Forces the argument slot in which it is placed to use the default value.`,
);

export const B_option = makeJSFun(
    "option",
    ["name"],
    ({ name }) => new OptionArg(withType(name, ["string"], "name")),
    `.func (option name)
..param {string} name - The name of the named option
.pure
. Uses the parameter's named value.`,
);

const OP_apply_id_trampoline = makeOpcode(
    null,
    (
        vm: JebVM,
        { 0: tail, 1: location }: [boolean | undefined, Location | undefined],
    ) => {
        const realFunc = popData(vm);
        const argsObj = popData(vm) as { _: any[] };
        pushData(vm, realFunc);
        pushCommand(vm, OP_apply, argsObj._, location, tail);
    },
    null,
);
const OP_JSFun_invoke = makeOpcode(
    null,
    <T extends JebVM>(
        vm: T,
        { 0: func, 1: location }: [JSFun<T>, loc?: Location | undefined],
    ) => checkNothingOrPush(vm, func.impl(popData(vm), vm, location)),
    null,
);
/**
 * The `apply` implementation for a host (Javascript) function: call it with
 * the bound arguments through the FFI.
 */
export const OP_ffi_invoke = makeOpcode(
    null,
    (vm: JebVM, { 0: f }: [Function]) => {
        const args = popData(vm)._;
        vm.emit("jeb:ffi/call_function", [f, args]);
        pushData(
            vm,
            wrapThrowToError(ErrnoCode.EJAVASCRIPT, () => f(...args)),
        );
    },
    null,
);

export const OP_index = makeOpcode(
    "index",
    (vm: JebVM, { 0: type }: [AccessType]) => {
        const field = popData(vm) as PropertyKey;
        const obj = popData(vm);
        if (obj instanceof Env) {
            pushData(vm, new VariableReference(type, obj, field as Identifier));
        } else if (obj instanceof NullHole) {
            // The hole is its own reference, for every field.
            pushData(vm, obj);
        } else if (typeof obj === "object" || typeof obj === "function") {
            pushData(vm, new ObjectPropertyReference(type, obj, field));
        } else {
            throw new JEBError(
                ErrnoCode.EINVAL,
                `${theTypeName(typeOf(obj))} is not subscriptable`,
            );
        }
    },
    `.sed obj name -- lvalue
..param {code} name - evaluated
.throws EINVAL - if the object can't be indexed
. Pushes the reference for the given field of the object: a variable reference for an environment, and a property reference for any other object.`,
);
export const OP_get = makeOpcode(
    "get",
    (vm: JebVM, { 0: shouldBind }: [boolean]) => {
        const lvalue = popData(vm);
        if (lvalue instanceof Reference || lvalue instanceof NullHole) {
            checkNothingOrPush(vm, lvalue.get(vm, shouldBind));
        } else {
            throw new JEBError(
                ErrnoCode.EINVAL,
                `${theTypeName(typeOf(lvalue))} is not a reference`,
            );
        }
    },
    `.imm accessType shouldBind
..param {AccessType} accessType
..param {boolean?} [shouldBind=false]
.sed lvalue -- value
. Takes a reference on the top of the stack and reads the value it points to: the result of its get() method, which may schedule opcodes and return NOTHING instead.`,
);
/**
 * Assigns `value` to `lvalue` (a reference, or the null-chaining hole, which
 * absorbs the assignment), or throws if the value cannot be assigned to.
 * With the `unevaluated` flag the value is still a block: the assignment
 * evaluates it (through `OP_assign_internal`, with `_` bound to the old
 * value) -- except through the hole, which drops it unevaluated and produces
 * the hole itself as the assignment's value.
 */
export const runSetter = (
    vm: JebVM,
    lvalue: any,
    value: any,
    flags: SetFlags,
) => {
    if (lvalue instanceof NullHole) {
        if (flags.unevaluated) pushData(vm, lvalue);
        return;
    }
    if (lvalue instanceof Reference) {
        if (flags.unevaluated) {
            pushCommand(
                vm,
                OP_assign_internal,
                value as Block,
                flags.old ?? false,
            );
            pushData(vm, lvalue);
            return;
        }
        lvalue.set(vm, value, flags.create, flags.readonly);
        return;
    }
    throw new JEBError(
        ErrnoCode.EINVAL,
        `cannot assign to ${theTypeName(typeOf(lvalue))}`,
    );
};
export const OP_assign = makeOpcode(
    "assign",
    (
        vm: JebVM,
        { 0: create, 1: readonly }: [create?: boolean, readonly_?: boolean],
    ) => {
        const lvalue = popData(vm);
        const value = peekData(vm);
        runSetter(vm, lvalue, value, {
            create: create ?? false,
            readonly: readonly ?? false,
        });
    },
    `.imm accessType create readonly
..param {AccessType} accessType
..param {boolean?} [create=false]
..param {boolean?} [readonly=false]
.sed value lvalue -- value
. Takes an LValue on the top of the stack and assigns the next item in the stack to it, by calling the reference's set() method.`,
);
// MARK: logic
export const OP_if = makeOpcode(
    "if",
    <T extends JebVM>(
        vm: T,
        {
            0: then,
            1: else_,
            2: isAsm,
        }:
            | [any, any, asm?: false | undefined]
            | [Command<T> | null, Command<T> | null, true],
    ) => {
        const condition = popData(vm);
        if (isAsm) {
            if (condition) {
                if (then) pushCommand(vm, ...then);
            } else if (else_) pushCommand(vm, ...else_);
        } else {
            pushData(vm, condition ? then : else_);
            pushCommand(vm, OP_eval, undefined, true);
        }
    },
    `.imm then else isAsm
Pops the top stack value, and if it's truthy, evaluates \`then\`, and if it's falsy, evaluates \`else\`.
..param {false?} isAsm
..param {code | null} then
..param {code | null} else
..sed condition -- result
.imm then else isAsm
Pops the top stack value, and if it's truthy, queues \`then\` to be executed as a command, and if it's falsy queues \`else\`.
..param {true} isAsm
..param {Command | null} then
..param {Command | null} else
..sed condition -- ???`,
);

const ALL_UNDERSCORE_QUOTED: CallableSignature = createSignature([
    [0, true, "_"],
]);

export const ALL_UNDERSCORE_NORMAL: CallableSignature = createSignature([
    [0, "_"],
]);

/**
 * Registers this file's builtins in the VM's builtins scope, in the order
 * listed. Called by {@link loadBuiltins}.
 */
export const loadEvalBuiltins = (vm: JebVM) => {
    define(vm, "audit", B_audit);
    define(vm, "eval", B_eval);
    define(vm, "macro", B_macro_wrap);
    define(vm, "object", B_object);
    define(vm, "at", B_atLocation);
    define(vm, "splat", B_splat);
    define(vm, "kw", B_keyword);
    define(vm, "blank", B_blank);
    define(vm, "option", B_option);
};

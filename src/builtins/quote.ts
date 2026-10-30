import { isArray } from "lib0/array";
import { define, makeJSFun } from "../define";
import { ErrnoCode } from "../errno";
import { JEBError } from "../errors";
import { isIdentifier } from "../utils";
import { captureMacroSource, JebVM } from "../vm";
import { MacroWrapper } from "../wrapper";
import { B_concat, B_list } from "./lists";

// MARK: metaprogramming
export const B_quote = makeJSFun("quote", [[true, "expr"]], ({ expr }) => expr,
    `.macro (quote expr) | (' expr) | 'expr
..param {code} expr
.pure
.returns {code}
. Prevents its argument from being evaluated.`);

// MARK: processQuasiquote
const processQuasiquote = (vm: JebVM, form: any, depth: number): any => {
    const env = vm.currentEnv;
    // atoms
    if (!isArray(form)) {
        if (typeof form !== "object" || form === null) {
            return form;
        } else {
            const newObj: Record<string, any> = {};
            for (var [key, value] of Object.entries(form)) {
                newObj[key] = processQuasiquote(vm, value, depth);
            }
            return newObj;
        }
    }
    if (form.length === 0) return [B_list];

    const { 0: head, 1: arg } = form;

    const same = (x: any, y: any) => {
        if (!isIdentifier(x)) return x === y;
        const v1 = env.get(x);
        return v1.ok && v1.data === y;
    }

    // ,x
    if (same(head, B_unquote)) {
        if (form.length !== 2) throw new JEBError(ErrnoCode.ESYNTAX, "expected 1 argument to unquote");
        return depth === 1 ? arg : [B_list, B_unquote, processQuasiquote(vm, arg, depth - 1)];
    }
    // ,@x
    if (same(head, B_unquoteSplicing)) {
        if (form.length !== 2) throw new JEBError(ErrnoCode.ESYNTAX, "expected 1 argument to unquoteSplicing");
        if (depth !== 1) return [B_list, B_unquoteSplicing, processQuasiquote(vm, arg, depth - 1)];
        throw new JEBError(ErrnoCode.ESYNTAX, "unquoteSplicing outside of list");
    }
    // nested `
    if (same(head, B_quasiquote)) {
        if (form.length !== 2) throw new JEBError(ErrnoCode.ESYNTAX, "expected 1 argument to quasiquote");
        return [B_list, B_quasiquote, processQuasiquote(vm, arg, depth + 1)];
    }

    // list – collect chunks, splice where needed
    const parts: any[] = [];
    const buffer: any[] = [];

    const flush = () => {
        if (buffer.length) {
            const part = [B_list];
            for (var e of buffer) {
                part.push(processQuasiquote(vm, e, depth));
            }
            parts.push(part);
            buffer.length = 0;
        }
    };

    for (var el of form) {
        if (!isArray(el) || depth !== 1) {
            buffer.push(el);
        }
        else if (same(el[0], B_unquoteSplicing)) {
            if (el.length !== 2) throw new JEBError(ErrnoCode.ESYNTAX, "expected 1 argument to unquoteSplicing");
            flush();
            parts.push(el[1]); // ,@x → will be spliced by concat
        } else {
            buffer.push(el);
        }
    }
    flush();

    if (parts.length === 0) return [B_list];
    if (parts.length === 1) return parts[0];
    // (concat part1 part2...)
    return [B_concat].concat(parts);
}

export const B_quasiquote = makeJSFun("quasiquote", [[true, "value"]], ({ value }, vm) => new MacroWrapper(processQuasiquote(vm, value, 1), captureMacroSource(vm)),
    `.macro (quasiquote value) | (~ value) | ~value
..param {any} value
.pure
.returns {any}
. Prevents \`value\` from being evaluated, but walks the elements and replaces [[unquote]] and [[unquoteSplicing]] with the results of evaluating their arguments. The argument to [[unquoteSplicing]] must be a list.`);

export const B_unquote = makeJSFun("unquote", [[true, "value"]], (_, vm) => { throw new JEBError(ErrnoCode.ESYNTAX, "unquote" + " not valid outside of quasiquote", {}, { return: vm.cc() }); },
    `.macro (unquote value) | (, value) | ,value
.returns {never}
.throws ESYNTAX - when called as a normal function outside of a [[quasiquote]].
. Marks a value to be interpolated inside a [[quasiquote]].`);
export const B_unquoteSplicing = makeJSFun("unquoteSplicing", [[true, "value"]], (_, vm) => { throw new JEBError(ErrnoCode.ESYNTAX, "unquoteSplicing" + " not valid outside of quasiquote", {}, { return: vm.cc() }); },
    `.macro (unquoteSplicing value) | (,@ value) | ,@value
.returns {never}
.throws ESYNTAX - when called as a normal function outside of a [[quasiquote]].
. Marks a list to be interpolated via splicing inside a [[quasiquote]].`);

/** Registers this file's builtins in the VM's builtins scope, in the order listed. Called by {@link loadBuiltins}. */
export const loadQuoteBuiltins = (vm: JebVM) => {
    define(vm, "quote", B_quote);
    define(vm, "quasiquote", B_quasiquote);
    define(vm, "unquote", B_unquote);
    define(vm, "unquoteSplicing", B_unquoteSplicing);
};

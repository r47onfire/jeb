import { loadEvalBuiltins } from "./eval";
import { loadVariablesBuiltins } from "./variables";
import { loadControlBuiltins } from "./control";
import { loadFfiBuiltins } from "./ffi";
import { loadCallablesBuiltins } from "./callables";
import { loadSchemeBuiltins } from "./scheme";
import { loadOperatorsBuiltins } from "./operators";
import { loadDataBuiltins } from "./data";
import { loadQuoteBuiltins } from "./quote";
import { loadJsonBuiltins } from "./json";
import { JebVM } from "../vm";

export { OP_audit, B_audit, OP_tbPop, OP_tbPush, OP_shuffle, OP_eval, B_eval, B_macro_wrap, OP_apply, B_atLocation, B_splat, B_keyword, OP_index, OP_get, OP_set, OP_if } from "./eval";
export { B_local, B_index, B_set, B_ref, B_deref, B_always, OP_set_env } from "./variables";
export { OP_throw, B_throw, B_err, B_with } from "./control";
export { B_is_nil } from "./ffi";
export { B_if, B_begin, B_let, B_let_in, B_define } from "./scheme";
export { B_plus, B_minus, B_mul, B_div, B_mod, B_pow, B_bitAnd, B_bitOr, B_bitXor, B_bitInv, B_eq, B_not_eq, B_less, B_greater, B_less_eq, B_greater_eq, B_not, B_and_shortcircuit, B_or_shortcircuit } from "./operators";
export { B_list, B_head, B_tail, B_concat } from "./data";
export { B_quote, B_quasiquote, B_unquote, B_unquoteSplicing } from "./quote";
export { B_jsonparse, B_jsonstringify } from "./json";

// MARK: loadBuiltins()
/**
 * Install the built-in functions and opcodes to the builtins scope of the given VM.
 *
 * Usually you don't need to do this, since the {@link JebVM} constructor calls this automatically,
 * but it might be needed if the VM state gets corrupted, or you mess with {@link JebVM#builtinsEnv} directly.
 */
export const loadBuiltins = (vm: JebVM) => {
    loadEvalBuiltins(vm);
    loadVariablesBuiltins(vm);
    loadControlBuiltins(vm);
    loadFfiBuiltins(vm);
    loadCallablesBuiltins(vm);
    loadSchemeBuiltins(vm);
    loadOperatorsBuiltins(vm);
    loadDataBuiltins(vm);
    loadQuoteBuiltins(vm);
    loadJsonBuiltins(vm);
};

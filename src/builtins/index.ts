import { JebVM } from "../vm";
import { loadCallablesBuiltins } from "./callables";
import { loadControlBuiltins } from "./control";
import { loadEvalBuiltins } from "./eval";
import { loadFFIBuiltins } from "./ffi";
import { loadJsonBuiltins } from "./json";
import { loadDataBuiltins } from "./lists";
import { loadOperatorsBuiltins } from "./operators";
import { loadQuoteBuiltins } from "./quote";
import { loadVarNamingBuiltins } from "./reference";
import { loadSchemeBuiltins } from "./scheme";
import { loadUnwrappingBuiltins } from "./unwrap";
import { loadVariablesBuiltins } from "./variables";

export { B_err, B_throw, B_with, OP_throw } from "./control";
export { B_atLocation, B_audit, B_blank, B_eval, B_keyword, B_macro_wrap, B_splat, OP_apply, OP_audit, OP_eval, OP_get, OP_if, OP_index, OP_set, OP_shuffle, OP_tbPop, OP_tbPush } from "./eval";
export { B_is_nil } from "./ffi";
export { B_jsonparse, B_jsonstringify } from "./json";
export { B_concat, B_head, B_list, B_tail } from "./lists";
export { B_and_shortcircuit, B_bitAnd, B_bitInv, B_bitOr, B_bitXor, B_div, B_eq, B_greater, B_greater_eq, B_less, B_less_eq, B_minus, B_mod, B_mul, B_not, B_not_eq, B_or_shortcircuit, B_plus, B_pow } from "./operators";
export { B_quasiquote, B_quote, B_unquote, B_unquoteSplicing } from "./quote";
export { B_begin, B_define, B_if, B_let, B_let_in } from "./scheme";
export { B_always, B_deref, B_index, B_local, B_ref, B_set, OP_set_env } from "./variables";

// MARK: loadBuiltins()
/**
 * Install the built-in functions and opcodes to the builtins scope of the given VM.
 *
 * Usually you don't need to do this, since the {@link JebVM} constructor calls this automatically,
 * but it might be needed if the VM state gets corrupted, or you mess with {@link JebVM#builtinsEnv} directly.
 */
export const loadBuiltins = (vm: JebVM) => {
    loadEvalBuiltins(vm);
    loadUnwrappingBuiltins(vm);
    loadVariablesBuiltins(vm);
    loadVarNamingBuiltins(vm);
    loadControlBuiltins(vm);
    loadFFIBuiltins(vm);
    loadCallablesBuiltins(vm);
    loadSchemeBuiltins(vm);
    loadOperatorsBuiltins(vm);
    loadDataBuiltins(vm);
    loadQuoteBuiltins(vm);
    loadJsonBuiltins(vm);
};

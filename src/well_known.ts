/**
 * The symbol under which each protocol's implementation lives when it is
 * provided by a value itself (as a method) rather than by a host-registered
 * implementation. The symbols are created with `Symbol.for`, so a Backolon
 * interned symbol with the same spelling (e.g. `:__add__`) is the same key, and
 * code written in JEB can install protocol methods on its own objects with
 * `(object (sym "__add__") (fn (self other) ...))`.
 *
 * `eval` has no symbol: evaluation is the VM's own business and values do not
 * get to override it. `get` and `set` are not registry protocols (they are the
 * two halves of the reference model), but they have symbols because any object
 * with `__get__`/`__set__` methods acts as a descriptor: it can be dereferenced
 * and assigned to without being a `Reference`. Indexing goes through
 * `__access__` only: an object with an `__access__` method controls indexing
 * itself -- the method is called with the index key and returns a descriptor
 * object (with `__get__`/`__set__` methods) for that property (see
 * `AccessReference`) -- and an object that wants to be its own descriptor
 * returns itself from `__access__`.
 */
export const PROTOCOL_SYMBOLS = {
    apply: Symbol.for("__call__"),
    access: Symbol.for("__access__"),
    unwrap: Symbol.for("__unwrap__"),
    name: Symbol.for("__name__"),
    get: Symbol.for("__get__"),
    set: Symbol.for("__set__"),
    add: Symbol.for("__add__"),
    abs: Symbol.for("__abs__"),
    sub: Symbol.for("__sub__"),
    neg: Symbol.for("__neg__"),
    div: Symbol.for("__div__"),
    inv: Symbol.for("__inv__"),
    mul: Symbol.for("__mul__"),
    matMul: Symbol.for("__matMul__"),
    mod: Symbol.for("__mod__"),
    cmp: Symbol.for("__cmp__"),
    pow: Symbol.for("__pow__"),
    bitAnd: Symbol.for("__bitAnd__"),
    bitOr: Symbol.for("__bitOr__"),
    bitXor: Symbol.for("__bitXor__"),
    shl: Symbol.for("__shl__"),
    shr: Symbol.for("__shr__"),
    bitNot: Symbol.for("__bitNot__"),
} as const;

/** The names that have a protocol symbol (every protocol except `eval`). */
export type ProtocolSymbolName = keyof typeof PROTOCOL_SYMBOLS;

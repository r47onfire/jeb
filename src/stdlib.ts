import { JSONCode } from "./evaluate";
import { JebVM, popData } from "./vm";

/**
 * The standard library: the derived forms of the old JEB library, updated for
 * the JSON-Lisp model. The library is data -- a program of `define` forms in
 * plain JSON code -- and {@link loadStdlib} installs it by evaluating that
 * program in the builtins environment, so these definitions go through exactly
 * the machinery user code does.
 *
 * The updates from the old library, mechanically: variable references are bare
 * strings now (no `$` form); the old `fn` is `lambda`; a macro is a function
 * with lazy (backticked) parameters whose body calls `set_macro_result` and
 * returns the expansion as data (built with `list`/`append`/`cons` where the
 * old library used `quasiquote`); and old member-access forms are gone.
 *
 * Two old entries are not here: `try` and `with-baffle` were built on the old
 * `with` form and the typed-error (`errno`) system, both of which now belong to
 * the layer above (Kuiper), not to JEB.
 */
export const STANDARD_LIBRARY: JSONCode[] = [
    // (uncomment form...) splices the forms back into a begin, undoing
    // a comment. A macro: lazy rest, result re-evaluated.
    [
        "define",
        "uncomment",
        [
            "lambda",
            ["...`items"],
            ["set_macro_result", true],
            ["append", ["list", ["quote", "begin"]], "items"],
        ],
    ],
    // call-with-current-continuation: inside the lambda, `return` is
    // this call's own injected return continuation, which is exactly
    // the current continuation of the cwcc call.
    [
        "define",
        "call-with-current-continuation",
        ["lambda", ["f"], ["f", "return"]],
    ],
    ["define", "cwcc", "call-with-current-continuation"],
    // (when test body...) == (if test (begin body...))
    [
        "define",
        "when",
        [
            "lambda",
            ["`test", "...`body"],
            ["set_macro_result", true],
            [
                "list",
                ["quote", "if"],
                "test",
                ["append", ["list", ["quote", "begin"]], "body"],
            ],
        ],
    ],
    // (unless test body...) == (if test (begin) (begin body...))
    [
        "define",
        "unless",
        [
            "lambda",
            ["`test", "...`body"],
            ["set_macro_result", true],
            [
                "list",
                ["quote", "if"],
                "test",
                ["list", ["quote", "begin"]],
                ["append", ["list", ["quote", "begin"]], "body"],
            ],
        ],
    ],
    // (while cond body...) == (when cond body... (while cond body...))
    [
        "define",
        "while",
        [
            "lambda",
            ["`cond", "...`body"],
            ["set_macro_result", true],
            [
                "append",
                ["list", ["quote", "when"], "cond"],
                "body",
                [
                    "list",
                    ["append", ["list", ["quote", "while"], "cond"], "body"],
                ],
            ],
        ],
    ],
    // (zero? x) -- needs the layer's `=` in scope, as the old one did.
    ["define", "zero?", ["lambda", ["x"], ["=", "x", 0]]],
    // (|> value step...) -- each step is an expression with the current
    // value bound to `%`; the first step is consumed as the value of
    // the recursive call, evaluated with `%` bound by the lambda.
    [
        "define",
        "|>",
        [
            "lambda",
            ["`value", "...`items"],
            ["set_macro_result", true],
            [
                "if",
                ["=", ["length", "items"], 0],
                "value",
                [
                    "list",
                    [
                        "list",
                        ["quote", "lambda"],
                        ["quote", ["%"]],
                        ["cons", ["quote", "|>"], "items"],
                    ],
                    "value",
                ],
            ],
        ],
    ],
    // (reduce list f value): fold f over the list starting from value.
    [
        "define",
        "reduce",
        [
            "lambda",
            ["list_", "f", "value"],
            [
                "if",
                ["=", ["length", "list_"], 0],
                "value",
                [
                    "reduce",
                    ["rest", "list_"],
                    "f",
                    ["f", "value", ["first", "list_"]],
                ],
            ],
        ],
    ],
    // (map list f): apply f to each element, collecting the results.
    [
        "define",
        "map",
        [
            "lambda",
            ["list_", "f"],
            [
                "reduce",
                "list_",
                [
                    "lambda",
                    ["acc", "cur"],
                    ["append", "acc", ["list", ["f", "cur"]]],
                ],
                ["list"],
            ],
        ],
    ],
];

/**
 * Installs the standard library: evaluates {@link STANDARD_LIBRARY} in the VM's
 * builtins environment (temporarily making it the current environment, so the
 * definitions land there). Runs the VM to completion synchronously; the library
 * is pure definitions, so this cannot pause.
 */
export const loadStdlib = (vm: JebVM<any, any>) => {
    const outer = vm.currentEnv;
    vm.currentEnv = vm.builtinsEnv;
    try {
        vm.start(["begin", ...STANDARD_LIBRARY]);
        while (!vm.done && !vm.error) vm.step();
        if (vm.error) throw vm.error;
        popData(vm); // discard the begin's value
    } finally {
        vm.currentEnv = outer;
    }
};

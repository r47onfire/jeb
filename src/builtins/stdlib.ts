// MARK: JSON based standard library!
// const STANDARD_LIBRARY = ["begin",
//     ["define", true, ["comment", "items", true],
//         `.macro (comment items...) | (#; items...) | #;(items...)
// ..param {any} items
// .returns {null}
// . Skips evaluating the items and returns null immediately.`,
//         null],
//     ["define", "#;", ["$", "comment"]],
//     ["define", true, ["uncomment", "items", true],
//         `.macro (uncomment items...) | (!; items...) | !;(items...)
// ..param {code} items
// . Evaluates the items as with [[begin]].`,
//         ["quasiquote", ["begin", ["unquoteSplicing", ["$", "items"]]]]],
//     ["define", "!;", ["$", "uncomment"]],
//     ["define", ["call-with-current-continuation", "f"],
//         `.func (call-with-current-continuation f) | (cwcc f)
// ..param {(k: Continuation) => any} f
// .returns {any} - possibly multiple times if the continuation is invoked later
// . Calls the function with a *continuation*, which is a special callable object. When the continuation is called with one argument, it will not return normally, and instead jump back to the place where \`cwcc\` was created from and make the \`cwcc\` return the given value instead - *even if* the \`cwcc\` expression has already returned!
// Invoking a continuation will cause the \`enter\` and \`exit\` handlers of [[with]] blocks jumped across to be triggered with \`true\` to indicate it was due to a continuation.
// Continuations can be used for very complex control structures and can be incredibly confusing to debug, so use with care.`,
//         ["f", ["$", "return"]]],
//     ["define", "cwcc", ["$", "call-with-current-continuation"]],
//     ["define", true, ["when", "test", "body", true],
//         `.macro (when test body...)
// ..param {boolean} test
// ..param {code => T} body
// .returns {T | null}
// . If \`condition\` is truthy, runs \`body\` as with [[begin]].
// (Equivalent to \`([[if]] condition ([[begin]] body...))\`.)`,
//         ["quasiquote",
//             ["if", ["unquote", ["$", "test"]],
//                 ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
//     ["define", true, ["unless", "test", "body", true],
//         `.macro (unless test body...)
// ..param {boolean} test
// ..param {code => T} body
// .returns {T | null}
// . If \`condition\` is falsy, runs \`body\` as with [[begin]].
// (Equivalent to \`([[when]] ([[not]] condition) body...)\`.)`,
//         ["quasiquote",
//             ["if", ["unquote", ["$", "test"]],
//                 null,
//                 ["begin", ["unquoteSplicing", ["$", "body"]]]]]],
//     ["define", true, ["try", "body", "handlers"],
//         `.macro (try body handlers)
// ..param {code} body - single statement that forms the body. If you need more than one statement, use [[begin]].
// ..param {object} handlers
// ...prop {(message: string, context: object) => ignored} (name) - called for the error with \`type\` equal to \`name\` (where \`name\` is the property name of the object).
// ...prop {(type: string, message: string, context: object) => ignored} * - called if an error is thrown, but no specific handler matched it
// ...prop {() => ignored} else - called if no error is thrown
// . Catches and handles errors.
// During evaluation of the body, if an error is thrown, the error's \`type\` (as returned by [[with]]) will be checked to see if it's in the handlers, and if it is, the handler is called with the \`message\` and \`context\` of the error.
// If no handler directly matches, the special catch-all handler \`"\\*"\` is tried.
// In both cases if the handler exists, \`true\` is returned to [[with]] to stop propagation of the error. If the handler wants to propagate the error, it should re-throw it using [[error]].`,
//         ["quasiquote", ["let", [["handlers", ["unquote", ["$", "handlers"]]]],
//             ["with", null, {
//                 exit: ["fn", ["k", "type", "message", "ctx"],
//                     ["let",
//                         [
//                             ["handler", ["$", ["handlers", ["$", "type"]]]],
//                             ["starHandler", ["$", ["handlers", "*"]]],
//                             ["elseHandler", ["$", ["handlers", "else"]]]
//                         ],
//                         ["unless", ["$", "type"],
//                             ["when", ["$", "elseHandler"], ["elseHandler"]],
//                             ["return", true]],
//                         ["when", ["$", "handler"],
//                             ["handler", ["$", "message"], ["$", "ctx"]],
//                             ["return", true]],
//                         ["when", ["$", "starHandler"],
//                             ["starHandler", ["$", "type"], ["$", "message"], ["$", "ctx"]],
//                             ["return", true]],
//                         false]],
//             },
//                 ["unquote", ["$", "body"]]]]]],
//     ["define", true, ["with-baffle", "body", true],
//         `.macro (with-baffle body...)
// ..param {code} body... - evaluated as with [[begin]]
// .throws jeb:state_error - if a continuation tries to jump in or out.
// . Prevents continuations from jumping in or out of \`body\`; only normal control flow or exceptions can be used to enter or exit.`,
//         ["quasiquote", ["with", null, {
//             enter: ["fn", ["k"],
//                 ["when", ["$", "k"],
//                     ["error", "jeb:state_error", "Continuation tried to jump into a 'with-baffle' block", {}]],
//                 null],
//             exit: ["fn", ["k", "_", true],
//                 ["when", ["$", "k"],
//                     ["error", "jeb:state_error", "Continuation tried to jump out of a 'with-baffle' block", {}]],
//                 false]
//         },
//             ["unquoteSplicing", ["$", "body"]]]]],
//     ["define", ["length", "x"], `.func (length value)
// ..param {any[] | string} value
// .returns {number} - the length of \`value\``,
//         ["$", ["x", "length"]]],
//     ["define", ["zero?", "x"], `.func (zero? value)
// ..param {number} value
// .returns {boolean} - true if \`value\` is zero`,
//         ["=", ["$", "x"], 0]],
//     ["define", true, ["|>", "value", "items", true],
//         `.macro (|> value expressions...)
// ..param {any} value
// ..param {code} expressions...
// ...injected {any} %
// . Pipes the \`value\` as the variable \`%\` into the next expression, and then the result of it becomes the next \`%\`, etc. until all expressions have been evaluated.
// This is analogous to Javascript's proposed pipe operator, specifically the Hack style.`,
//         ["if", ["zero?", ["length", ["$", "items"]]],
//             ["$", "value"],
//             ["quasiquote",
//                 [["fn", true, ["%"],
//                     ["|>", ["unquoteSplicing", ["$", "items"]]]],
//                 ["unquote", ["$", "value"]]]]]],
//     ["define", ["reduce", "list", "f", "value"],
//         `.func (reduce list function value)
// ..param {T[]} list
// ..param {(value: R, item: T) => R} function
// ..param {R} value
// .returns {R}
// . Repeatedly call the function with 2 arguments; the first one is the current \`value\` and the second is each element of \`list\` in turn. The return value will be the new \`value\` for the next element.
// When the list is empty, returns the accumulated value.`,
//         ["if", ["zero?", ["length", ["$", "list"]]],
//             ["$", "value"],
//             ["reduce",
//                 ["tail", ["$", "list"]],
//                 ["$", "f"],
//                 ["f", ["$", "value"], ["head", ["$", "list"]]]]]],
//     ["define", ["map", "list_", "f"],
//         `.func (map list function)
// ..param {T[]} list
// ..param {(x: T) => R} function
// .returns {R[]}
// . Return a new list with the result of applying the function to each element of the list in order.`,
//         ["reduce",
//             ["$", "list_"],
//             ["fn", ["acc", "cur"],
//                 ["concat", ["$", "acc"], ["list", ["f", ["$", "cur"]]]]],
//             ["list"]]],
//     ["define", true, ["while", "cond", "body", true],
//         `.macro (while cond body...)
// ..param {code => boolean} cond
// ..param {code} body
// . Evaluates \`cond\` repeatedly, followed by \`body\`, until \`cond\` evaluates to a falsy value and then returns null.`,
//         ["quasiquote", ["when",
//             ["unquote", ["$", "cond"]],
//             ["unquoteSplicing", ["$", "body"]],
//             ["while", ["unquote", ["$", "cond"]], ["unquoteSplicing", ["$", "body"]]]]]],
// ];

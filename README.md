# JEB

simple JSON evaluation virtual machine with first-class continuations

## how?

JSON arrays are treated much the same way Lisp/Scheme cons lists are.

however, Lisp/Scheme has symbols _and_ strings, while JSON only has strings. so, strings do double duty here:

1. a string always evaluates to the variable of that name -- in head position, in argument position, everywhere.
2. if you want an actual string as data, you quote it: `["quote", "the string"]`.
3. numbers, booleans, and `null` evaluate to themselves.

one more trick: an object at the head of a call form is not code at all -- it is the call's location. `[{"line": 1, "col": 2}, "foo", "bar"]` calls `foo(bar)` and records the call as occurring at line 1, column 2. locations are opaque values; the runtime just carries them into tracebacks, and builtins like `throw_runtime_error`, `hide_call`, and `redirect_call` let code move or hide the location a call is blamed on. objects are valid nowhere else in code.

everything else -- `quote`, `lambda`, `if`, `let`, macros -- is an ordinary value in the builtins environment, not syntax. there are no named opcodes: evaluation dispatches on the shape of the JSON value directly.

there is no macro system either, exactly: a parameter whose name starts with a backtick (`` `x ``) receives its argument's raw form instead of its value, and a function that calls `set_macro_result(true)` has its return value re-evaluated as code in the caller's environment. a "macro" is just a function that does one or both of those, decided per call at runtime -- `quote` is nothing special either, just a builtin whose one parameter is lazy, and user code can define its own the same way with `lambda`.

## continuations?

these are accomplished by compiling the JSON evaluation process into micro-operations for a lower-level stack machine on the fly as it's evaluated. a continuation simply stores a snapshot of what the data stack and instruction stack are when it was captured (among other things), and surreptitiously replaces them when invoked.

JEB also supports a Scheme-like `dynamic-wind` context manager syntax, so code can know when it's jumping in and out, and for what reason (normal, continuation, or exception).

## naming

canonically, JEB stands for "JSON Evaluation Backend". however, JEB can stand for many other things:

- Judicious, Elegant, Brilliant - when it works
- Janky Expression Builder - when other people see it
- Just Enough Brackets - when you get sick of writing it
- Javascript's Evil Brother - when it breaks

it does not have anything to do with Jens Bergensten.

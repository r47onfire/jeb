# JEB

simple JSON evaluation virtual machine with first-class continuations

## how?

JSON arrays are treated much the same way Lisp/Scheme cons lists are.

however, Lisp/Scheme has symbols *and* strings, while JSON only has strings. so, two special things happen here:

1. if you need to look up a variable, you use `["$", varname]`
2. you don't need to do the above if the string is in head/function position, "calling" a string looks it up and calls the value implicitly (this is literally how "$" is implemented there, it's just a builtin function defined in the global environment)

## continuations?

these are accomplished by compiling the JSON evaluation process into micro-operations for a lower-level stack machine on the fly as it's evaluated. a continuation simply stores a snapshot of what the data stack and instruction stack are when it was captured (among other things), and replaces them when invoked.

JEB also supports a Scheme-like `dynamic-wind` context manager syntax, so code can know when it's jumping in and out, and for what reason (normal, continuation, or exception).

## what's currently not yet implemented

* more functional programming primitives (fold, map, flatMap, etc)
* optional parameters in lambdas/macros
* a more lisp-like syntax (this will be done with a Python lisp->json converter)

## naming

canonically, JEB stands for "JSON Evaluation Backend". however, JEB can stand for many other things:

* Judicious, Elegant, Brilliant - when it works
* Janky Expression Builder - when other people see it
* Just Enough Brackets - when you get sick of writing it
* Javascript's Evil Brother - when it breaks

it does not have anything to do with Jens Bergenstein.

# JEB Evaluation and Runtime Specification

## Abstract

This document specifies the core expression representation, evaluation semantics, callable protocol, environment model, reference model, continuation behavior, dynamic-wind behavior, and host-extension interfaces of JEB (JSON Evaluation Backend).

JEB evaluates JSON-shaped code using a small virtual machine. JSON arrays represent calls, JSON objects represent object expressions, and all other JSON values are literals unless a protocol extension gives them another meaning. JEB also supports first-class continuations and dynamically scoped enter/exit handlers.

This specification describes the semantic contract of JEB. It does not require a particular class layout, opcode layout, stack representation, or scheduler implementation.

## Requirements Language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

## Status of This Specification

This document describes the intended core JEB behavior. Implementations MAY expose additional host APIs, protocols, opcodes, or value types. An implementation claiming conformance to a section MUST follow that section's normative rules.

## 1. Terminology and Scope

### 1.1 Value Types

Implementations MUST support all JSON values which are the portable core value set:

- `null`
- booleans
- numbers
- strings
- arrays
- objects with string keys

Additionally, implementations MUST also define the following complex types:

- Host-implemented native functions
- References
- Lambdas
- Blocks
- Continuations
- Wrappers

An implementation MAY allow the user code to access internal fields of the complex types.

### 1.2 Protocols

A **protocol** is a well-known abstract operation contract that is dynamically dispatched on the runtime types of its arguments. Hosts MAY define additional type cases for the standard protocols for types not defined here and MAY add new protocols. New protocols MUST NOT be named conflicting names with any existing protocol.

The standard protocols are:

- `eval`
- `apply`
- `access`
- `unwrap`

When multiple protocol implementations match, dispatch SHOULD choose the most specific applicable implementation. If no implementation matches, the operation MUST throw an appropriate type error or return the documented no-handler result.

An implementation MUST NOT allow user code to access or modify existing protocols.

## 2. Evaluation

### 2.1 General evaluation rule

Evaluation MUST be dispatched using the `eval` protocol.

The implementation MUST define, at minimum, `eval` overloads for the following value types:

- an array is evaluated as a call expression;
- an object is evaluated by evaluating all property values and reassembling an object with the same keys;
- a string, number, boolean, or `null` evaluates to itself;
- a callable object such as a lambda, native function wrapper, or block evaluates to itself.

A host extension MAY register an evaluator for another type.

### 2.2 Literal values

Primitive literal values MUST evaluate to themselves unless an evaluator protocol explicitly overrides that behavior.

In particular, strings are literals when they are evaluated as values. A string obtains its implicit variable/function lookup behavior only when it is used as the callee of a call expression, as specified in Section 3.

### 2.3 Objects

When an object is evaluated by the default object evaluator:

1. the result object is created;
2. each own property key is retained;
3. each property value is evaluated in the current environment;
4. the evaluated value is assigned to the corresponding key in the result object.

Property evaluation MUST preserve the set of own keys. Property evaluation order SHOULD follow the host's own-key order for the source object. If the object is, at runtime, a subclass of the default object type, the result SHOULD be of the same type.

`null` MUST remain a literal and MUST NOT be treated as an object expression.

### 2.4 Arrays

A non-empty array is a call expression. The first item is the callee expression and every remaining item MUST NOT be evaluated until the selected callable signature determines how each argument is handled.

An empty array SHOULD throw a value error. Alternatively, an implementation MAY assign another meaning to empty arrays through an explicitly registered `eval` protocol implementation.

## 3. Application

### 3.1 Call evaluation

The `apply` protocol contract MUST define a way to retrieve a callable value's signature without performing the call. It MAY also support retreiving the value's qualified name, for use in error tracebacks.

To evaluate an array call expression:

1. the callee expression MUST be evaluated first;
2. the resulting value MUST be looked up using the `apply` protocol;
3. the selected callable's signature MUST determine which arguments are evaluated, quoted, wrapped as blocks, or otherwise interpreted;
4. the callable MUST directly or inderectly produce a single result.

A value that has no applicable `apply` protocol implementation MUST cause a type error.

A call MAY be marked as a tail call. Tail-call metadata MUST be honored by the VM's traceback and command scheduling behavior where the implementation supports tail-call elimination but MUST NOT cause the tail-eliminated frame to be hidden in an error stack trace.

### 3.2 String and symbol callees

When a string or symbol is used as the callee of a call, it MUST be treated as an implicit lookup of a variable or function with that name, followed by application.

Therefore, these forms are semantically equivalent:

```text
["foo", argument]
[["$", "foo"], argument]
```

The first form performs the lookup implicitly because the string is in head position. A string in any non-callee position MUST remain a literal string.

If the lookup fails, the call MUST throw a reference error identifying the missing function.

### 3.3 Callable values

The core runtime supports at least two callable categories:

- a host/native function wrapper
- a lambda, which closes over the environment in which it was defined.

An implementation MAY add callable categories by registering an `apply` protocol implementation. Every callable protocol implementation MUST provide enough metadata for argument binding, including its signature and optional traceback name.

## 4. Argument Signatures

A callable signature describes positional parameters, optional parameters, lazy parameters, quoted/code parameters, flag parameters, positional rest parameters, and keyword rest parameters.

### 4.1 Ordinary parameters

An ordinary parameter MUST receive the evaluated and unwrapped value of its corresponding argument expression.

Required parameters MUST precede optional parameters. A function definition that attempts to place a required parameter after an optional one MUST result in a syntax error.

A call with too few required arguments MUST throw a value error.

### 4.2 Optional parameters

An optional parameter has a default expression. When the caller does not supply that parameter, the default expression MUST be evaluated in a dynamic environment of both the function's closure environment (if one exists for the function) and the environment from which the function was called.

A default expression MUST NOT be evaluated when an explicit argument supplies the parameter.

### 4.3 Lazy parameters (Blocks)

A lazy parameter receives an implicit `Block` instead of the immediate value of its argument expression. The argument expression MUST NOT be evaluated before being wrapped in the `Block`.

### 4.4 Quoted parameters

A quoted parameter MUST receive the argument code unevaluated but without being wrapped in anything. This permits a callable to inspect or transform code directly.

<!-- A `MacroWrapper` marks a returned code value for evaluation in the caller's environment and for replacement of the wrapper in the surrounding evaluation. This permits unhygienic syntax-like macros. -->

### 4.5 Flags

A parameter MAY declare flags controlling how its value is passed. When the expression supplying a flagged parameter is evaluated, the implementation MUST check to see if the wrapper tag is the same as any of the ones declared on the parameter, and if any match, the value MUST NOT be unwrapped.

### 4.6 Positional rest parameters

A positional rest parameter receives all remaining positional arguments after fixed parameters have been bound. The rest value MUST preserve positional order.

### 4.7 Keyword arguments

A keyword argument wrapper redirects an argument to a named parameter. A keyword rest parameter receives all otherwise-unmatched keyword arguments in an object-like mapping. A keyword argument MUST NOT be able to send its value into lazy or quoted parameter.

A splat argument wrapper requests unpacking of an iterable or object into positional or keyword arguments. A splat argument MUST report a type error if the value that is requested to be unpacked is not an iterable.

An error MUST also be thrown if the iterable is the wrong length, that is:

- there are still required parameters left unfilled after exhausting the iterable and processing the remaining arguments (too short); or
- there are still items left in the iterable after filling all the parameters of the signature and there is no rest parameter (too long); or
- the next value from the iterable would land in a lazy or quoted parameter (also too long).

Invalid, duplicate, missing, or incompatible argument assignments MUST throw a value error. <!-- TODO: define "invalid"/"incompatible" -->

## 5. Environments

An environment is a mapping from identifiers to values, with zero or more parent environments.

Lookup MUST search the current environment first and then its parents recursively. If there are multiple parents, the implementation MAY search the parents in any order.

Declaring a binding in the current environment MUST always create or replace a binding in that environment. A constant binding MUST reject all later assignments, unless shadowed in a child environment.

Assignment to an existing binding MUST update the environment in which that binding was originally declared. Assignment to an absent binding MUST throw a reference error unless the operation explicitly requests declaration.

A lambda MUST capture the environment associated with its body, including all of its parents. An implementation MAY choose to discard bindings it can prove will never be used by the lambda's body, though doing so may not be possible if the body invokes macros that dynamically create variable names.

## 6. References

A reference is a value representing an assignable slot. References may represent variables, object properties, or other host-defined locations.

Obtaining a reference MUST always go through the `access` protocol.

### 6.1 Variable references

The `$` builtin creates a reference to a variable by name:

```json
["$", "name"]
```

Reading an undefined variable MUST throw a reference error. Assigning to a constant MUST throw a type error. Assigning to an undefined variable MUST throw a reference error unless declaration was requested.

### 6.2 Property references

The `.` builtin creates a reference to an object property:

```json
[".", objectExpression, propertyNameExpression]
```

The object expression and property name expression MUST be evaluated according to normal argument semantics before the property reference is created.

The default object accessor MUST support property reads and writes for objects.

A host accessor MAY bind a retrieved host function to its owning object when the access operation requests binding.

Property access and mutation MUST emit the appropriate audit events when the host runtime exposes audit hooks.

### 6.3 Reference wrappers

A reference used as an ordinary value MUST be unwrapped by getting its current value. A reference passed to a reference-aware function (such as `set`) MUST NOT be unwrapped, and MUST remain a reference until that operation consumes it.

## 7. Blocks and Sequencing

A `Block` is a deferred sequence of code expressions together with the environment in which the block was created.

Invoking a block MUST evaluate its expressions in order. The value of the block invocation MUST be the value of its final expression. Invoking an empty block MUST return `null`.

A block MUST preserve its closure environment. It MUST NOT be equivalent to merely storing the source AST without the environment needed for deferred evaluation.

The `apply` protocol implementation MUST report that a `Block` has one optional parameter. When the block is called with a parameter, it MUST be validated to be a mapping of name to value, and if it is valid, those values MUST be injected into the body's environment for that evaluation and that evaluation only. A second invocation of the block MUST NOT be able to access or modify the previous evaluation's arguments or mapping object.

A `Block` is not a wrapper and MUST NOT be automatically/implicitly invoked at any point.

## 8. Continuations

### 8.1 First-class continuation value

A continuation captures sufficient VM state to resume computation from the point at which it was created. At minimum, a continuation MUST capture:

- the current environment;
- the pending command/instruction stack;
- the data stack;
- the traceback state, if it's stored separately from the command stack;
- implementation-specific VM state required for correct resumption;
- the dynamic-wind state needed to process a jump.

Invoking a continuation MUST restore the captured state and supply the invocation value as the resumed computation's result. A continuation MUST be able to be invoked any number of times.

A continuation invocation MUST replace the current control state rather than merely calling the continuation as an ordinary function.

### 8.2 Dynamic-wind interaction

A continuation jump MUST compare the dynamic-wind path at the point of invocation with the path captured by the continuation.

When leaving dynamic-wind contexts, exit handlers MUST run from the innermost context outward until the common ancestor is reached. When entering captured contexts, enter handlers MUST run from the common ancestor inward.

Handlers MUST run in the correct order even when a continuation crosses multiple contexts. An exception that leaves a dynamic-wind context MUST also run applicable exit handlers before becoming an uncaught host error.

## 9. Dynamic-Wind Contexts

A dynamic-wind context has an optional enter handler and an optional exit handle, which are both functions. The context MUST be active for the duration of its body and for any continuation execution that is dynamically inside it.

A context operation MUST:

1. establish the context;
2. run the enter handler, if present;
3. evaluate the body;
4. run the exit handler, if present;
5. return the body's value unless a handler changes control flow.

An enter handler MUST be given information about whether control is entering normally or via a continuation. The return value of the enter handler MAY be stored in a variable and made accessible to the body.

An exit handler MUST be given information about whether control is leaving normally, through a continuation jump, or because of an error. If the handler is being invoked due to an error, the return value MUST be tested for truthiness, and if the value is truthy, the error MUST NOT propagate further up the dynamic-wind chain.

## 10. VM Execution

### 10.1 Tail calls

A tail call MAY reuse or replace the current command frame. Tail calls MUST preserve program behavior and MUST NOT cause unbounded traceback growth solely because of tail recursion.

Traceback metadata MUST NOT be affected by a tail call; the tail-eliminated frame MUST remian visible in any traceback from an error occuring during the extent of the tail call.

### 10.2 Errors

A JEB error has a stable type tag, a message, optional context, and optional traceback data.

The core error categories include:

- runtime errors;
- reference errors;
- value errors;
- type errors;
- syntax errors;
- state errors;
- recursion errors.

An uncaught JEB error MUST be surfaced to the host. A dynamic-wind context MAY intercept an error before it reaches the host. The host MUST terminate the JEB program if an error is not intercepted.

## 11. Audit Hooks

The VM MAY expose audit hooks for security-sensitive or externally observable operations.

When audit hooks are enabled, the runtime MUST emit the documented event before the point of the audited operation. At minimum, object property access and mutation, audit-hook registration, and other host/FFI boundaries SHOULD be auditable.

The audit hook mechanism MUST NOT silently swallow errors thrown by an audit hook callback, as this is the only way for an audit hook to abort the operation if it determines the host has denied permission or otherwise disallowed the audited operation.

Audit hooks MUST NOT silently change the meaning of an operation.

## 12. Locations (For Diagnostics)

Operations MAY carry source-location metadata. An implementation of this mechanism as a macro wrapper of an expresion SHOULD NOT show up in the traceback.

Callers SHOULD attach the location of the call site to application and evaluation operations. Tracebacks SHOULD report function names and call locations when available.

## 13. Serialization

The portable JEB code representation SHOULD remain JSON-compatible:

- arrays represent call expressions;
- objects represent object expressions;
- primitive values represent literals;
- strings in callee position represent implicit name lookup.

Host-only values such as functions, lambdas, environments, references, wrappers, blocks, continuations, and errors are not required to be JSON-serializable. An implementation exposing serialization for them MUST define the serialization boundary explicitly.

## 14. Non-Goals

This specification does not prescribe:

- a particular bytecode or opcode encoding;
- a particular host class hierarchy;
- a particular garbage collector or stack representation;
- a particular asynchronous scheduling policy;
- the complete builtin library;
- the exact syntax of a source language that compiles to JEB;
- the complete set of arithmetic, comparison, collection, or FFI protocols;
- whether host-only values are immutable, serializable, or transferable between VMs.

Future extensions MUST preserve the central semantic boundary: JSON-shaped code is data until evaluated, evaluation and application are protocol-driven, and continuation invocation restores control state rather than performing an ordinary nested call.

import subprocess
import re
import sys

errno_h_expanded = subprocess.check_output(
    ["gcc", "-E", "-"],
    input=b"#include <errno.h>",
    stderr=subprocess.DEVNULL,
).decode()

real_errno_h = re.findall(r'"?(\S*?errno\.h\S*?)', errno_h_expanded)

errno_triples = {
    0: ("EFAIL", "Unspecified error"),
    -1: ("ENAME", "No such variable"),
    -2: ("EFUNC", "No such function"),
    # EINVAL for type error
    # ERANGE for value error
    -3: ("ESYNTAX", "Unrecognized syntax"),
    -4: ("EJAVASCRIPT", "Javascript error"),
    # EPROCLIM for recursion error
    -255: ("EPANIC", "Internal error"),

    # Some HTTP error equivalents
    1000: ("EHTTP", "HTTP error"),
    221: ("EKICKED", "Bye"),
    400: ("EBADREQ", "Bad request"),
    401: ("EUNAUTH", "Unauthorized"),
    403: ("EREFUSED", "Forbidden"),
    404: ("ENOTFOUND", "Not found"),
    418: ("ETEAPOT", "I'm a teapot"),
    429: ("ERATELIMIT", "Too many requests"),
    451: ("ELAWYER", "Unavailable for legal reasons"),
    500: ("ESERVERERROR", "Internal server error"),
    502: ("EUPSTREAM", "Bad gateway"),
    504: ("EPROXYWAIT", "Gateway timeout"),
    999: ("ELOGIN", "Request denied"),
}

seen = set()
for file in real_errno_h:
    if file in seen:
        continue
    seen.add(file)
    errno_h = open(file).read()
    for exp in re.finditer(r"#define\s+(E[A-Z]+)\s+(\d+)(?:\s*/\*\s*(.+?)\s*\*/)?", errno_h):
        name, str_num, text = exp.groups()
        num = int(str_num)
        if num not in errno_triples:
            errno_triples[num] = (name, text)
        else:
            print("Duplicated:", num, name, text, file=sys.stderr)

print("/**")
print(" * @fileoverview")
print(" * AUTO-GENERATED! DO NOT EDIT!")
print(" * Checked files:")
for file in seen:
    print(f" * * {file}")
print(" */")
print("/**")
print(" * Errno database mapping E-code to value")
print(" */")
print("export enum ErrnoCode {")
for n, (name, text) in errno_triples.items():
    print("    /**")
    print(f"     * {text}")
    print("     */")
    print(f"    {name} = {n},")
print("};")
print()
print("/**")
print(" * Errno database mapping E-code to string description default")
print(" */")
print("export const ErrnoDesc: Record<ErrnoCode, string> = {")
for n, (name, text) in errno_triples.items():
    print(f"    [ErrnoCode.{name}]: {text!r},")
print("};")

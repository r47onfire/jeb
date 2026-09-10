import subprocess
import re

errno_h_expanded = subprocess.check_output(
    ["gcc", "-E", "-"],
    input=b"#include <errno.h>",
    stderr=subprocess.DEVNULL,
).decode()

real_errno_h = re.findall(r'"?(\S*?errno\.h\S*?)', errno_h_expanded)

errno_triples = {
    -1: ("ENAME", "Variable not found"),
    -2: ("EFUNC", "Function not found"),
    # EINVAL for type error
    # ERANGE for value error
    -3: ("ESYNTAX", "Unrecognized syntax"),
    -4: ("EJAVASCRIPT", "Javascript error"),
    # ELOOP for recursion error
    -255: ("EPANIC", "Internal error")
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

print("/**")
print(" * @fileoverview")
print(" * AUTO-GENERATED! DO NOT EDIT!")
print(" * Checked files:")
for file in seen:
    print(f" * * {file}")
print(" */")
print("export enum ErrnoCode {")
for n, (name, text) in errno_triples.items():
    print(f"    {name} = {n},")
print("};")
print()
print("export const ErrnoDesc: Record<ErrnoCode, string> = {")
for n, (name, text) in errno_triples.items():
    print(f"    [ErrnoCode.{name}]: {text!r},")
print("};")

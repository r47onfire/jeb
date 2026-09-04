#!/usr/bin/env python3

import sys
import json
import argparse
from pyparsing import ParseException

from . import transpile

ap = argparse.ArgumentParser()

ap.add_argument("-m", "--minify", action="store_true", help="minify the output JSON")
ap.add_argument("-o", "--output", default="-", help="output (default stdout)")
ap.add_argument("-i", "--input", default="-", help="input file to read (default stdin)")
argv = ap.parse_args()

src = sys.stdin.read() if argv.input == "-" else open(argv.input).read()
try:
    print(json.dumps(transpile(src), indent=None if argv.minify else 2, separators=(",", ":") if argv.minify else None), file=sys.stdout if argv.output == "-" else open(argv.output, "w"))
except ParseException as e:
    print(f"Parse error: {e}", file=sys.stderr)
    sys.exit(1)

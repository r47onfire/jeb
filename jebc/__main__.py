import sys
import json
from pyparsing import ParseException

from . import transpile

if __name__ == "__main__":
    src = sys.stdin.read() if len(sys.argv) == 1 else open(sys.argv[1]).read()
    try:
        out = transpile(src)
        out = out[0] if len(out) == 1 else ["begin", *out]
        print(json.dumps(out, indent=2))
    except ParseException as e:
        print(f"Parse error: {e}", file=sys.stderr)
        sys.exit(1)

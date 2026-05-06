#!/usr/bin/env python3

from pyparsing import *
from pyparsing import pyparsing_unicode as unicode

ParserElement.set_default_whitespace_chars(" \t\r\n")
ParserElement.enable_packrat()

# --- tokens ---
LPAR, RPAR = map(Suppress, "()")
LBRACE, RBRACE = map(Suppress, "{}")
COLON = Suppress(":")
comment = ";" + rest_of_line

expr = Forward()

# atoms
string = (QuotedString('"', '\\', unquote_results=True, multiline=True, convert_whitespace_escapes=True) |
          QuotedString("'", '\\', unquote_results=True, multiline=True, convert_whitespace_escapes=True))
number = pyparsing_common.number()
boolean = ((Keyword("#t") | Keyword("true")).set_parse_action(lambda: True) |
           (Keyword("#f") | Keyword("false")).set_parse_action(lambda: False))
nil = (Keyword("nil") | Keyword("null")).set_parse_action(lambda: None)

symbol = Word(unicode.alphas + unicode.nums + "_!$%&*+-./:<=>?@^~")

js_identifier = Word(unicode.alphas + unicode.nums + "_$")

object_key = string | js_identifier

# $var → ["get", "var"]
variable = (Suppress("$") + symbol).set_parse_action(lambda t: [["$", t[0]]])

# quotes
quoted = (Suppress("'") + expr).set_parse_action(lambda t: [["'", t[0]]])
quasiquoted = (Suppress("`") +
               expr).set_parse_action(lambda t: [["`", t[0]]])
unquote_splice = (
    Suppress(",@") + expr).set_parse_action(lambda t: [",@", t[0]])
unquoted = (Suppress(",") + expr).set_parse_action(lambda t: [[",", t[0]]])

# (list)
list_expr = LPAR + ZeroOrMore(expr) + RPAR
list_expr.set_parse_action(lambda t: [list(t)])
# list_expr.ignore(comment)

# {key: expr, ...}
object_key = string | js_identifier
key_value = Group(object_key + COLON + expr)
object_expr = LBRACE + Optional(delimited_list(key_value, ",")) + RBRACE
object_expr.set_parse_action(lambda t: [{k: v for k, v in t.as_list()}])
# object_expr.ignore(comment)

atom = variable | number | string | boolean | nil | symbol
expr <<= quoted | quasiquoted | unquote_splice | unquoted | list_expr | object_expr | atom
expr.ignore(comment)
toplevel = ZeroOrMore(expr)
toplevel.ignore(comment)


def transpile(src: str):
    result = toplevel.parse_string(src, True)
    return result.as_list()

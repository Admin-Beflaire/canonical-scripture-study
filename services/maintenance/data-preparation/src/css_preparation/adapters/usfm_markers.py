"""Lexical markers for the supported USFM format."""

import re

MARKER = re.compile(r"\\(\+?[A-Za-z][A-Za-z0-9-]{0,23})(\*|(?=\s|\\|$))")
BOOK = re.compile(r"[1-9A-Z][A-Z0-9]{2}(?=\s|$)")

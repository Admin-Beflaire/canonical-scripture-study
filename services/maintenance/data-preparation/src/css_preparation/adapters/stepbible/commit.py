"""Shared validation for a pinned STEPBible-Data commit."""
import re

COMMIT_PATTERN = re.compile(r'[0-9a-f]{40}')

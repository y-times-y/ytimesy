"""utils.textfmt: text formatting helpers used across the notes toolkit."""

import re
import textwrap

__all__ = [
    "wrap",
    "truncate",
    "slugify",
    "title_case",
    "strip_markup",
    "indent_block",
]

SMALL_WORDS = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to"}
_MARKUP = re.compile(r"(\*\*|__|\*|_|`|~~)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def wrap(text, width=40):
    """Wrap text to width columns, joining lines with newlines."""
    return "\n".join(textwrap.wrap(" ".join(text.split()), width=width))


def truncate(text, limit, suffix="..."):
    """Shorten text to at most limit characters, ending with suffix when cut."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: max(0, limit - len(suffix))].rstrip()
    return cut + suffix


def slugify(text):
    """Lower-case, ASCII, hyphen-separated slug."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "untitled"


def title_case(text):
    """Title-case text, keeping small words lower-case except at the start."""
    words = text.split()
    out = []
    for index, word in enumerate(words):
        lower = word.lower()
        if index and lower in SMALL_WORDS:
            out.append(lower)
        else:
            out.append(lower[:1].upper() + lower[1:])
    return " ".join(out)


def strip_markup(text):
    """Remove simple markdown emphasis and turn links into their labels."""
    text = _LINK.sub(r"\1", text)
    return _MARKUP.sub("", text)


def indent_block(text, prefix="    "):
    """Prefix every non-empty line of text."""
    return "\n".join(prefix + line if line.strip() else line for line in text.split("\n"))

"""Render notes as plain text."""

from utils.dates import human_date
from utils.textfmt import indent_block, title_case, wrap


def render_note(note, width=40):
    heading = title_case(note["title"])
    body = wrap(note["body"], width)
    lines = [heading, "=" * len(heading), human_date(note["date"]), "", body]
    if note.get("quote"):
        lines += ["", indent_block(wrap(note["quote"], width - 4), "  > ")]
    return "\n".join(lines)

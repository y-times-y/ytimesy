"""Email digests."""

from utils import textfmt


def subject(text):
    """Subject line for a note title."""
    return "[notes] " + textfmt.title_case(textfmt.truncate(text, 40))


def preview(text, limit=60):
    plain = textfmt.strip_markup(text)
    return textfmt.truncate(plain, limit)


def digest(notes):
    lines = []
    for note in notes:
        text = note["body"]
        lines.append(f"- {textfmt.title_case(note['title'])}: {preview(text, 50)}")
    return "\n".join(lines)

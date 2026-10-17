"""One-line summaries for a list of notes."""

from utils import slugify, truncate


def summary_line(note, limit=30):
    return f"{slugify(note['title'])}: {truncate(note['body'], limit)}"


def summary(notes, limit=30):
    return "\n".join(summary_line(note, limit) for note in notes)

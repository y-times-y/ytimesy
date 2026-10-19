"""Plain-text search over notes."""

from utils.dates import parse_date
from utils.textfmt import strip_markup


def matches(note, query):
    haystack = strip_markup(note["title"] + " " + note["body"]).lower()
    return all(word in haystack for word in query.lower().split())


def search(notes, query, since=None):
    found = [note for note in notes if matches(note, query)]
    if since:
        found = [note for note in found if parse_date(note["date"]) >= parse_date(since)]
    return sorted(found, key=lambda note: note["date"])

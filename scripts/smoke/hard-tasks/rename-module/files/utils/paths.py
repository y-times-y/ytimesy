"""Path helpers."""

from .textfmt import slugify


def note_filename(title, extension="md"):
    """File name for a note title."""
    return f"{slugify(title)}.{extension}"


def archive_path(year, title):
    return f"archive/{year}/{note_filename(title)}"

"""Export notes to a dictionary of files."""

from utils.paths import note_filename


def export_notes(notes):
    from utils.textfmt import slugify, wrap

    files = {}
    for note in notes:
        name = note_filename(note["title"])
        files[name] = f"# {note['title']}\n\n{wrap(note['body'], 60)}\n"
    files["index.md"] = "\n".join(f"- {slugify(n['title'])}" for n in notes) + "\n"
    return files

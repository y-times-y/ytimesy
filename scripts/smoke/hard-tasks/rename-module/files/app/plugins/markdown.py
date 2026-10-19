"""Markdown cleanup plugin."""

import utils.textfmt


def clean(text):
    lines = [utils.textfmt.strip_markup(line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def heading(text):
    return utils.textfmt.title_case(clean(text))

"""Date helpers."""

from datetime import date


def parse_date(value):
    """Parse YYYY-MM-DD."""
    year, month, day = (int(part) for part in value.split("-"))
    return date(year, month, day)


def human_date(value):
    return parse_date(value).strftime("%d %b %Y")

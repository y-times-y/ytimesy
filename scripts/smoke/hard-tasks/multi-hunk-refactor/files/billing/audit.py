"""Audit trail of every state change."""

from .legacy_audit import current

EVENTS = []


def record(kind, **fields):
    """Append an audit event and return it."""
    details = current()
    event = {"kind": kind, "request_id": details["request_id"], "actor": details["actor"], **fields}
    EVENTS.append(event)
    return event


def events(kind=None):
    return [event for event in EVENTS if kind is None or event["kind"] == kind]


def reset():
    EVENTS.clear()

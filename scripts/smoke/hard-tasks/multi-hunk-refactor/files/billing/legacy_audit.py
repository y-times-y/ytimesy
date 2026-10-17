"""Request-scoped audit details, kept in module globals.

api.handle sets these before running a request and clears them afterwards.
"""

_CURRENT = {"request_id": None, "actor": None}


def set_current(request_id, actor):
    _CURRENT["request_id"] = request_id
    _CURRENT["actor"] = actor


def clear_current():
    set_current(None, None)


def current():
    return dict(_CURRENT)

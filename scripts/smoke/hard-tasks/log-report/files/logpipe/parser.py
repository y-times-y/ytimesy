from datetime import datetime, timedelta, timezone


def parse_offset(text):
    if text in ("", "Z"):
        return timedelta(0)
    sign = 1 if text[0] == "+" else -1
    hours, minutes = text[1:].split(":")
    return sign * timedelta(hours=int(hours), minutes=int(minutes))


def parse_line(line):
    stamp, method, path, status, ms = line.split()
    local = datetime.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")
    offset = parse_offset(stamp[19:])
    utc = (local + offset).replace(tzinfo=timezone.utc)
    return {
        "time": utc,
        "method": method,
        "path": path,
        "status": int(status),
        "ms": int(ms),
    }

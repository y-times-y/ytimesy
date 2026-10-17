def window_start(time, minutes):
    return time.replace(
        minute=time.minute - time.minute % minutes, second=0, microsecond=0
    )


def bucket(records, minutes=5):
    windows = {}
    for record in records:
        windows.setdefault(window_start(record["time"], minutes), []).append(record)
    return windows

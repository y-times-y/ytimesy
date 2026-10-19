from .parser import parse_line
from .stats import median
from .window import bucket


def summarize(lines, minutes=5):
    records = [parse_line(line) for line in lines if line.strip()]
    rows = []
    for start, items in bucket(records, minutes).items():
        label = f"{start:%Y-%m-%d} {start.hour}:{start:%M}"
        errors = sum(1 for item in items if item["status"] >= 500)
        p50 = median(item["ms"] for item in items)
        rows.append(f"{label} requests={len(items)} errors={errors} p50={p50:.1f}")
    return "\n".join(sorted(rows))

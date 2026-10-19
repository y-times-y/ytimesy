# logpipe

Summarizes access logs into fixed time windows.

Input lines: `<ISO-8601 timestamp with offset or Z> <method> <path> <status> <milliseconds>`, e.g.
`2026-03-01T23:59:30+02:00 GET /a 200 120`. Blank lines are ignored.

`logpipe.report.summarize(lines, minutes=5)` returns one line per non-empty window, in chronological order:

`YYYY-MM-DD HH:MM requests=<n> errors=<n> p50=<median>`

- Window starts are in UTC, zero-padded, aligned to multiples of `minutes` within the hour.
- `errors` counts status >= 500.
- `p50` is the median of the window's milliseconds (the mean of the two middle values for an even count), printed with one decimal place.

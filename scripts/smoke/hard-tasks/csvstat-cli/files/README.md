# csvstat

`python3 csvstat.py FILE --column NAME [--format text|json]`

Prints statistics for one numeric column of a CSV file. Standard library only.

- `FILE` is a path, or `-` to read standard input.
- The first row is the header. Fields follow standard CSV quoting (a quoted field may contain commas and quotes).
- A cell counts as numeric when, after stripping surrounding whitespace, Python's `float()` accepts it and the value is finite (not nan or inf). Every other cell in the column, including blank ones and rows too short to have the column, is skipped and counted in `skipped`.
- Statistics over the numeric cells: `count`, `skipped`, `mean`, `median` (mean of the two middle values for an even count), `min`, `max`. Numbers are rounded to 4 decimal places. With no numeric cells, mean/median/min/max are null in JSON and `n/a` in text.

Output:

- `--format json`: a single line holding one JSON object with keys `column`, `count`, `skipped`, `mean`, `median`, `min`, `max`.
- `--format text` (the default): one `key: value` line per key, in the order above.

Errors: an unknown column or an unreadable file prints a message naming it on standard error and exits with status 2. Success exits 0.

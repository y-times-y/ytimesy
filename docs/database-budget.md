# Database egress budget

The app reads and rewrites whole chat transcripts (0.1 to 0.5 MB of jsonb), so egress and write volume grow faster than row counts. Two tools keep it visible.

## Large-result log line

`src/server/adapters/database-byte-accounting.ts` wraps every pool and checked-out client. When one query returns about 100 KB or more, it logs one line:

`{"event":"db.large_result","query":"<hash> <first words of the SQL>","approxBytes":N,"rows":N}`

The size is estimated from a sample of the rows, never by serializing the result, and the tag never contains values. Search worker logs for `db.large_result` and group by `query`. Off under vitest unless `DATABASE_BYTE_ACCOUNTING=1`; `DATABASE_BYTE_ACCOUNTING=0` turns it off everywhere. It counts result size per query, not network bytes, so use it to rank queries, not to bill.

## Daily report

`scripts/db-budget-report.ts` is read-only and prints database size, the top tables by total size with dead tuples, and the top queries by calls and by rows from `pg_stat_statements` (normalized text, no values). It ends with `PASS` or `WARN (n)` and exits 1 on WARN. The daily run is `.github/workflows/database-budget-report.yml` (draft; needs the secrets listed in its comments).

Run it by hand: `node --env-file=.env --import tsx scripts/db-budget-report.ts` (`DB_REPORT_DATABASE_URL` wins over `DATABASE_URL`).

Reading it:

- The thresholds at the top of the script are our own alarm lines, not plan limits. Check the Supabase plan (Dashboard, Usage) for the included database size and egress, compare the report's size against it, and lower the thresholds if the plan is smaller. The environment variables `BUDGET_DATABASE_BYTES`, `BUDGET_TABLE_BYTES`, `BUDGET_QUERY_ROWS`, `BUDGET_QUERY_CALLS` override them.
- Query counters are cumulative since the last `pg_stat_statements` reset, so a WARN means "heavy so far". To measure a change, note the numbers, wait a day, and compare.
- A high `rows` count on a query that reads `transcript` or other jsonb columns is the egress suspect; match it with `db.large_result` lines.
- Many dead tuples on a table that is rewritten often (chat transcripts) means vacuum is behind or the rewrite rate is too high.

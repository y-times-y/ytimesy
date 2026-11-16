# Database egress budget

The app reads and rewrites whole chat transcripts (0.1 to 0.5 MB of jsonb), so egress and write volume grow faster than row counts. Two tools keep it visible.

## Large-result log line

`src/server/adapters/database-byte-accounting.ts` wraps every pool and checked-out client. When one query returns about 100 KB or more, it logs one line:

`{"event":"db.large_result","query":"<hash> <first words of the SQL>","approxBytes":N,"rows":N}`

The size is estimated from a sample of the rows, never by serializing the result, and the tag never contains values. Search worker logs for `db.large_result` and group by `query`. Off under vitest unless `DATABASE_BYTE_ACCOUNTING=1`; `DATABASE_BYTE_ACCOUNTING=0` turns it off everywhere. It counts result size per query, not network bytes, so use it to rank queries, not to bill.

## Large-read report and scaling boundary

Run `node --import tsx scripts/egress-report.ts 24` for the last 24 hours.
The table ranks the 15 largest query/service groups, while a separate ungrouped
query supplies the total across **all** logged groups. Missing or invalid totals
fail the report instead of reporting zero. Reads below the logging threshold,
protocol overhead and other egress remain outside this estimate. Its `PASS` only
checks the configured monthly projection for the measured account traffic; it
does not establish capacity for 100 power users.

Read-only measurement on 2026-11-16: about 1.72 GB of logged large results in
24 hours, of which the displayed groups covered 97.1%. The largest groups were
chat-page reads (672 MB / 2,815 calls) and transcript-page batches
(347 MB / 69 calls). This is not the Supabase billing meter or a post-deploy
measurement of the current local changes. The continuation-history read is
now locally narrowed to messages, model/revision, state and failover, rather than
`select *` (which also transferred unused turn fields). Full transcript authority
has not moved out of Postgres, and the 100-power-user budget remains unverified.

## Daily report

`scripts/db-budget-report.ts` is read-only and prints database size, the top tables by total size with dead tuples, and the top queries by calls and by rows from `pg_stat_statements` (normalized text, no values). It ends with `PASS` or `WARN (n)` and exits 1 on WARN. The daily run is `.github/workflows/database-budget-report.yml` (draft; needs the secrets listed in its comments).

Run it by hand: `node --env-file=.env --import tsx scripts/db-budget-report.ts` (`DB_REPORT_DATABASE_URL` wins over `DATABASE_URL`).

Reading it:

- The thresholds at the top of the script are our own alarm lines, not plan limits. Check the Supabase plan (Dashboard, Usage) for the included database size and egress, compare the report's size against it, and lower the thresholds if the plan is smaller. The environment variables `BUDGET_DATABASE_BYTES`, `BUDGET_TABLE_BYTES`, `BUDGET_QUERY_ROWS`, `BUDGET_QUERY_CALLS` override them.
- Query counters are cumulative since the last `pg_stat_statements` reset, so a WARN means "heavy so far". To measure a change, note the numbers, wait a day, and compare.
- A high `rows` count on a query that reads `transcript` or other jsonb columns is the egress suspect; match it with `db.large_result` lines.
- Many dead tuples on a table that is rewritten often (chat transcripts) means vacuum is behind or the rewrite rate is too high.

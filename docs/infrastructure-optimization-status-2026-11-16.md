# Infrastructure optimization checkpoint — 2026-11-16

This is a measured checkpoint, not a completion or capacity claim. The target is
100 users as active as the owner or more, no Cloudflare overage beyond Workers
Paid, low Supabase egress, unchanged 4 vCPU / 16 GiB workspace defaults, and no
production/account credentials on AWS runners. Do not relax durability or secret
isolation to hit the cost target.

## Measurements

- `node --import tsx scripts/egress-report.ts 24`: approximately 1.72–1.73 GB
  of estimated **logged large database results** in the preceding 24 hours.
  This excludes reads below 100 KB, other egress and protocol overhead. The top
  15 query/service groups covered approximately 97% of the logged total, not
  100%. The script now obtains the total with a separate ungrouped calculation,
  and rejects missing or invalid totals rather than treating them as zero.
- Largest logged groups: web chat-page reads, 672 MB / 2,815 calls; web
  transcript-page batches, 347 MB / 69 calls. These measurements predate the
  local continuation-query change and do not show its effect.
- Cloudflare GraphQL `durableObjectsPeriodicGroups`, production namespaces,
  complete UTC hours **2026-11-15 03:00 through 2026-11-16 03:00**, summed
  `activeTime` and `cpuTime` (microseconds converted to seconds):

  | Namespace class | Active seconds | CPU seconds |
  | --- | ---: | ---: |
  | ModelConversation | 119,838.3 | 1,004.8 |
  | BackgroundJobRunner | 3,361.4 | 22.8 |
  | ProjectEnvironment | 2,349.4 | 10.7 |
  | UserHub | 142.0 | 0.3 |

  One query per production namespace, at most 30 hourly groups, filtered by
  `namespaceId`, inclusive `datetimeHour_geq` and exclusive `datetimeHour_lt`.
  These are analytics, not the invoice. Concurrent objects add active time, so
  an account can exceed 86,400 active seconds in one day. This mixed-deployment
  account workload does not establish a per-user or post-optimization rate.

## Local changes at this checkpoint

- The continuation-history query selects only messages, model/revision, state
  and failover; it no longer transfers every field of the previous `api_turn`.
  It still loads the required model-message history, not a bounded-history
  architecture replacement.
- Box identity file uploads stage privately beside the resolved destination,
  then flush and atomically replace it after all chunks arrive. Small uploads
  remain one exec. Interrupted uploads do not truncate the original file.
  Local shell tests cover failed second chunks, Unicode, empty files,
  executable modes and symlinks. No live provider crash injection is claimed.
- Test fixture type errors in parked-turn, settled-item and box-MCP tests were
  corrected without removing assertions. `pnpm typecheck` subsequently exited 0.
- `YTIMESY_TARGET=cloudflare pnpm build` exited 0. Plain `pnpm build` tried the
  Node target and failed resolving the existing `cloudflare:sockets` import;
  the successful Worker-target build is not a Node-build fix.

## Verification checkpoint

- `env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run --maxWorkers=2`
  exited 0: 6,189 passed, 8 skipped, 863 test files passed and 3 skipped.
  The clean environment prevents runtime credentials/settings from changing
  isolated fixtures. Initial runs exposed stale migration and VM mocks; those
  were fixed without updating snapshots or removing assertions.
- `pnpm exec tsc --noEmit` exited 0 after the fixture repairs.
- Changed TypeScript files passed Biome. Repository-wide `pnpm lint` still
  reports 17 errors and 144 warnings outside that focused check.
- The egress report passed a clean-copy run after installing declared
  dependencies with the Corepack download prompt disabled.

## Active-turn working-view follow-up (local, not deployed)

- Modern turn markers now load visible items from their indexed start position,
  rather than reconstructing every older turn from Postgres or a local cache.
  Matching predecessor model history still supplies its prefix locally; a stale
  version falls back to the saved model messages, not an unverified prefix.
- Independently parseable local item pages let a cache hit start at the active
  user message or internal wake notice without joining/parsing old pages. Legacy
  array-shaped turn rows retain their compatibility read path for one deploy.
- Stream-only cache mirrors now stay in memory after the corresponding Postgres
  progress write commits. Model/tool checkpoints persist the local cache; after
  a reset, a newer Postgres version misses the older cache and reloads committed
  progress. This removes SQLite mutations from those stream-only mirrors; it
  does not remove the Postgres progress writes or make SQLite authoritative.
- A failed cache write invalidates its version before changing pages, and cache
  reads/writes are best-effort. Oversized individual cache items fall back to
  Postgres rather than failing the turn.
- Focused tests cover a different chat with 60 archived large items and only two
  active items, preservation of archived content after checkpointing, wrong
  leases/missing markers, predecessor-version mismatch, wake anchors, reset
  recovery, and zero SQL mutations during stream-only cache updates.
- `pnpm typecheck` and `YTIMESY_TARGET=cloudflare pnpm build` exited 0 for
  this follow-up. The nine changed TypeScript files passed Biome.
- The final focused history/recovery run exited 0: 210 tests in eight files.
  The full-suite attempt passed 6,195 tests with eight skipped, but exited 1
  because the Git CGI test fixture emitted an unhandled stdin `EPIPE` when its
  child stopped reading a refused push. The fixture now keeps that CGI response
  while forwarding other input errors to its reader; its 12 tests and Biome
  passed (exit 0). The rerun exited 0: 6,195 passed and eight skipped,
  with 863 test files passed and three skipped. That run preceded the newer
  memory-dream projection; the projection has its separate focused checks below.

This removes memory/egress growth from **older visible turns on the modern
execution path**, not all possible growth. One extremely long active turn,
model history, other full-transcript readers, and the legacy compatibility path
still require work. Existing output previews are not a durable archive of the
complete output and must not be described as lossless history. No 128 MiB
worst-case proof, production result, or 100-user budget claim follows from these
local tests.

## Memory-dream egress follow-up (local, not deployed)

- `memoryChatsSince` now projects just the fields `dreamChat` consumes inside
  Postgres: user text/timing, non-commentary replies, and failed-command metadata
  with output tails. Tool bodies, successful-command output and commentary stay
  in the database. The authoritative transcript and `memoryChat` source reader
  are unchanged. This does not bound all user/reply text in an unlimited chat.
- A PGlite integration fixture verifies identical dream input with/without a
  since boundary and failure inclusion, including supplementary Unicode in output
  tails, first-five-failure selection, and last-reply selection. Its returned
  projection is less than one twentieth the original fixture.
- Memory adapter/job checks exited 0: 33 tests. `pnpm exec tsc --noEmit`
  exited 0 after this change.
- Read-only production-data verification with the local adapter (no deployment):
  one eligible chat had 1,677 original items / 3,782,978 serialized bytes versus
  277 projected items / 163,834 bytes, a 95.67% reduction for this read. All four
  dream-input comparisons (since/no since, failures/no failures) were equal.
  The diagnostic connection set `default_transaction_read_only=on`; no chat
  text, user identifiers or credentials were printed. This one-chat result is
  not an account-wide billing reduction or a 100-user capacity measurement.
- A fresh `node --import tsx scripts/egress-report.ts 24` exited 0: 1.78 GB
  of logged large results; ranked groups covered 96.6%. This still predates
  deployment of these changes and excludes small reads/other provider egress.

## Memory diagnostics follow-up

The step-size logger no longer serializes an entire history array into a second
large string just to measure it. It sums the JSON framing and UTF-8 byte count
of each entry, so supplementary Unicode is counted correctly rather than as
JavaScript string length. Cache-hit steps still skip this serialization walk.
The four step-size tests and edge-executor TypeScript check exited 0; the new
test compares exact serialized UTF-8 sizes and asserts neither whole array is
serialized. This bounds the diagnostic temporary allocation to one entry, not
the underlying turn state or a single oversized entry.

An additional clean-environment VM sizing/lifecycle and box-grant regression
run exited 0 (25 tests in three files). These fixture tests are not evidence
that live AWS boxes have had their persistent credentials removed.

## Remaining gates

- Safe workspace pause during remote-model waits must preserve background
  commands, interactive access, shared workspaces and local Claude execution.
- Full transcript/model-state loading and authoritative Postgres history still
  need bounded-memory/storage work. Do not describe a cache as that migration.
- Box tool journaling is not durable across a restarted runner process. An
  atomic file upload does not make an uncertain tool call safe to replay.
- Runtime-secret box tools remain opt-in/off: VM-side output redaction is not
  access control. A VM exec token can bypass the wrapper and read VM secrets.
- Live runner/proxy HMAC-to-public-key maintenance and permanent credential
  isolation are not completed by the edge-side Ed25519 implementation.
- Representative post-deploy usage and crash/failover verification are still
  needed before claiming the 100-power-user budget or uninterrupted recovery.

No production deployment was performed for these local changes at this checkpoint.

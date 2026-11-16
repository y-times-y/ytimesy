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

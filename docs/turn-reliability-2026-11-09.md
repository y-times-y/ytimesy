# Turn progress resets and Claude SDK startup

## Observed failures

Production rows for thread `6acf4158-f5e1-49f6-96ea-f098407d440d` recorded three failed turns whose cause was `Durable Object's isolate exceeded its memory limit and was reset.` The affected turn histories were approximately 2 MB each for messages and items. The generic progress-save error hid a platform reset, not an authentication failure.

In thread `dda92bf3-5571-4159-bd98-c6cd778204f6`, the first-use installation of SDK 0.3.321 was interrupted after the 300-second foreground exec budget. The machine retained working SDK 0.3.296 and an incomplete 0.3.321 temporary directory. Its npm log showed downloads in progress, not a rejected Claude token.

## Changes

- Treat the exact Cloudflare isolate-memory reset as a platform interruption. Keep the processing receipt for the existing fenced, bounded recovery path instead of settling the turn as a progress failure. Ordinary database failures and command memory failures remain distinct.
- The turn-history SQLite mirror checks for existing messages with `select 1`, without reconstructing the message history on each items-only progress update.
- In-process snapshot delivery calls the conversation room directly instead of serializing into a Request and parsing the same snapshot again.
- Snapshot broadcasts encode one immutable SSE frame shared by viewers, rather than serializing and encoding the whole snapshot for each viewer. Owner checks, revision ordering, purge fences and backpressure remain.
- First-use SDK installation uses the existing detached-command journal. A stable turn/version identity reattaches after step boundaries or restarts; an incomplete install yields `continue` without starting Claude. Installation is bounded by `STEP_BUDGET_MS`, while individual VM exec calls only launch or inspect it. A healthy installed SDK keeps the short startup path.
- The installer prefers npm's existing cache and retains error diagnostics. Its flock waits under the detached process's timeout instead of independently failing after five minutes. Operator logs redact setup output; user errors do not expose npm output.
- Deployment, migration inspection and running-turn checks accept the configured `DATABASE_SSL_CA` / `SUPABASE_CA_CERT` before falling back to a certificate file. TLS verification remains enabled. This avoids an empty gitignored certificate file blocking an otherwise configured deployment machine.

## Evidence and boundaries

- The detached installer completed with status 0 on the affected chat machine; SDK 0.3.321's binary reports Claude Code 2.1.321. The installation journal recorded approximately 21 seconds on the subsequent attempt. This does not imply the original network delay is always reproducible.
- A native SDK process completed a localhost-only scripted response (`SDK_STARTUP_OK`) with a temporary isolated home and a fake credential. No provider inference or real Claude token was used in this smoke test.
- Regression tests cover pending installation, reattachment identity, cancellation, redaction, startup gating, exact reset classification and recovery without finalizing the turn as failed.
- Local workerd tests cover persisted snapshot recovery and eight changing snapshots over 2 MB delivered to sixteen viewers. Unit tests also verify the same broadcast buffer is shared and that progress writes do not read cached message bodies.
- Production preflight and both Worker deployment dry runs passed. The production database reports no pending migrations. These checks do not deploy code or prove live post-deploy recovery.

## Final check results

- Focused reliability run: 193 tests passed across 16 files, exit 0.
- Full suite in a clean environment: 5,457 passed, 10 failed, 8 skipped, exit 1. One failure was the existing first-event SSE test assuming an entire event arrived in a single network chunk; it now uses the maintained SSE parser and the full realtime file passes. The other nine failing cases reproduced on untouched `origin/main` (`6e251d60`): model-list expectations, the Node Harbor bundle importing `cloudflare:sockets`, ownership-sensitive tree digests, background-install fixtures, and Git remotes rewritten by this machine's Git configuration. No production logic or expectations were weakened to hide them.
- `pnpm typecheck`: exit 0 after correcting the deployment helper import.
- Production preflight: exit 0; both Worker deployment dry runs: exit 0. A normal Node-target `pnpm build` fails on the existing `cloudflare:sockets` import; the production Cloudflare build succeeds.

The focused command (with no production credentials in the test environment) was:

```sh
env -i PATH="$PATH" HOME="$HOME" CI=1 YTIMESY_USER_5H_MICRO_USD=5000000 YTIMESY_USER_WEEKLY_MICRO_USD=25000000 pnpm exec vitest run src/server/jobs/api-turn.test.ts src/server/adapters/freestyle/machine-failure.test.ts src/server/services/turn-progress-writer.test.ts src/server/services/claude-agent-sdk.test.ts src/server/services/claude-code-runner.test.ts src/server/adapters/freestyle/detached-command.test.ts src/domain/guest-cli-pin.test.ts tests/turn-history-cache.test.ts tests/conversation-room-subscribe.test.ts tests/conversation-purge.test.ts tests/conversation-room-reclaim.test.ts tests/realtime-worker.test.ts tests/supabase-certificate.test.ts tests/running-turns-check.test.ts tests/production-settings.test.ts tests/production-preflight.test.ts --maxWorkers=4
```

The allocation reductions and reset recovery do not establish that every possible long chat fits within the isolate memory limit. Recovery remains bounded; repeated exhaustion is not retried forever. The installer is a shared machine capability, so cancelling a waiting turn stops its polling but can leave the bounded installation finishing for other turns.

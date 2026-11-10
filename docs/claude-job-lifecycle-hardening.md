# Claude job lifecycle hardening — 2026-11-10

## Implemented, not deployed

- `api-turn.ts` exposes the tracked workspace surface over MCP on both execution hosts. Code mode is constructed for Claude even when the experiment variant disables it or uses the older workspace surface. The extra plan tool is not constructed for Claude, so it cannot leak back through code mode; TodoWrite still supplies the UI plan.
- `claude-code-runner.ts` disables native workspace and task tools when launching a new process on either host. Its prompt directs long commands through the offered tools' background mechanism, with output inspection and no untracked shell detaching. AWS mode receives the same guidance. Reader isolation is unchanged.
- `claude-code-turn.ts` does not close the bridge on a recognized platform reset. The existing detached process and pending queued calls belong to the turn, not the interrupted step. Ordinary failures still close the queue.
- `claude-code-bridge.ts` labels a timed-out started call as outcome unknown, rather than falsely saying it never ran and telling the model to retry. Work timing out while still queued is removed before it can start. No automatic replay of user commands is added.

## Checks completed

- Clean-environment focused regression command across 16 files: **252 tests passed, exit 0**. Files: `src/server/jobs/api-turn.test.ts`, `src/server/services/claude-code-runner.test.ts`, `src/server/services/claude-code-turn.test.ts`, `src/server/services/claude-code-bridge.test.ts`, `src/domain/claude-runner.test.ts`, `src/server/services/lean-tools.test.ts`, `src/server/services/api-agent-command-tools.test.ts`, `src/server/services/background-command-context.test.ts`, `src/server/services/background-command-notices.test.ts`, `src/server/services/background-exit-callback.test.ts`, `src/server/services/background-history-compaction.test.ts`, `src/server/services/turn-progress-writer.test.ts`, `tests/turn-executor.test.ts`, `tests/turn-history-cache.test.ts`, `tests/conversation-room-subscribe.test.ts`, `tests/realtime-worker.test.ts`. Exact invocation:

```sh
env -i PATH="$PATH" HOME="$HOME" CI=1 YTIMESY_USER_5H_MICRO_USD=5000000 YTIMESY_USER_WEEKLY_MICRO_USD=25000000 pnpm exec vitest run src/server/jobs/api-turn.test.ts src/server/services/claude-code-runner.test.ts src/server/services/claude-code-turn.test.ts src/server/services/claude-code-bridge.test.ts src/domain/claude-runner.test.ts src/server/services/lean-tools.test.ts src/server/services/api-agent-command-tools.test.ts src/server/services/background-command-context.test.ts src/server/services/background-command-notices.test.ts src/server/services/background-exit-callback.test.ts src/server/services/background-history-compaction.test.ts src/server/services/turn-progress-writer.test.ts tests/turn-executor.test.ts tests/turn-history-cache.test.ts tests/conversation-room-subscribe.test.ts tests/realtime-worker.test.ts --maxWorkers=4
```
- `pnpm typecheck`: **exit 0**.
- `YTIMESY_TARGET=cloudflare CLOUDFLARE_ENV=production pnpm build`: **exit 0**.
- Regression cases include deploy and isolate-memory reset bridge preservation, user-stop queue closure, queued versus started call timeouts, background job registration/output/completion, process reattachment, and large-snapshot delivery to sixteen viewers. These are automated tests, not a real deployment-during-inference test.

## Not a universal reliability fix

The broader request is **not complete**. These changes do not fix the growing full-history allocations documented in `docs/research/do-memory-limit-long-chats-2026-11-10.md`. They do not implement runner assignment persistence, admission/concurrency scaling, draining, runner failover, or large transcript transfer beyond the existing checkpoint size limit. Runner loss can still lose uncheckpointed progress; changing the runner list can still relocate a chat. No claim of unlimited demand or zero interruptions follows from the tests.

No production settings were changed, no runners restarted, and no live Claude inference or production fault injection was performed for this patch. Existing native background jobs are not adopted into ytimesy tracking. This is backend wiring with no UI changes, so no screenshot is claimed. The public harness has no hosted Claude MCP bridge/runner placement equivalent; no public-repo port or npm publish was performed.

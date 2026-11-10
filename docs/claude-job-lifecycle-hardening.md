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

## Follow-up fixes

- Persist the first AWS runner origin in the conversation DO's SQLite storage. Pool edits no longer silently rehash an existing chat onto a machine missing its local session. Stop/failover targets that origin even when its Freestyle workspace is unavailable.
- Bound transcript display and delivery to 200 items and a 256 KiB byte budget, splitting a long turn at item boundaries. One individually oversized item remains readable. Older pages remain available; nothing is deleted. Read context usage independently so paging out the user message does not erase the context indicator.
- Probe Claude transcript size on its host before transferring it into the Worker. A 249 MiB transcript is not loaded merely to reject its upload. Keep a previous valid checkpoint for the same session instead of clearing it.
- Protect a live runner's run directory and active/resumed session from both age and disk-pressure cleanup. Protection checks the scoped PID's start tick, so a reused PID does not protect stale work. The SDK records its actual session ID on initialization.
- Serialize launch/reattach with a per-run shell lock, close the inherited lock FD in the detached child, and repair a missing current pointer without launching twice. Real subprocess tests race two launches and exercise the generated SDK wrapper with a fixture SDK.
- Remove the runner signing key from subprocess environments; handle spawn failure; kill timed-out short-exec process groups without killing independently detached Claude runs. New service units use `KillMode=process`.
- Fix background environment installation under tmux: preserve the requested HOME even when reusing a server, and retain a PTY descriptor until the redirected installer finishes. Otherwise tmux can terminate the installation before its completion status is published.

The broader suite also exposed fixture/environment issues: isolate Git transport checks from the host's global URL rewrites; use the existing Ubuntu container for ownership checks when not root; handle fixture stdin EPIPE; update model-catalog expectations; and keep the Workers-only TCP tunnel import bundleable while explicitly failing closed in Node. Assertions were not relaxed to hide an application failure.

## Follow-up validation

- `pnpm typecheck` and `YTIMESY_TARGET=cloudflare CLOUDFLARE_ENV=production pnpm build`: **exit 0** after repairing the cleanup declaration.
- Five-file repair regression: **52 tests passed, exit 0**. Runner/cleanup regression: **29 tests passed, exit 0**. Git transport regression: **7 tests passed, exit 0** after reproducing both host-config failures.
- `env -i PATH="$PATH" HOME="$HOME" CI=1 pnpm check:first-paint --runs 1 --shots .ytimesy/interruption-ui-shots`: **exit 0**, eight desktop/phone scenarios, CLS 0.0000 and no hydration warnings.
- Shared-desktop check against a throwaway local Worker/Postgres fixture at `http://127.0.0.1:8799/thread/04d84a0f-0d1a-4537-a2f9-8d10d550b530`: latest output from a 503-item synthetic transcript renders without an application error. This does not test real model inference.
- `env -i PATH="$PATH" HOME="$HOME" CI=1 YTIMESY_USER_5H_MICRO_USD=5000000 YTIMESY_USER_WEEKLY_MICRO_USD=25000000 pnpm exec vitest run --maxWorkers=2`: **exit 0**, 789 files passed, three skipped; 5,524 tests passed and eight existing skips. Earlier failing runs are not counted as passes; their reproduced fixture failures were repaired before this full rerun.
- PR CLI evidence reruns the actual runner, box API and cleanup tests: **38 tests passed, exit 0**. No inference or provider credentials are needed by those tests.

## Remaining failure domains and rollout

The display/delivery bounds and transcript-size guard reduce specific memory hazards; execution still loads the cumulative `api_turn` items and structured history. That remaining growth is documented in `docs/research/do-memory-limit-long-chats-2026-11-10.md`; no heap profile or full execution-history normalization is claimed. Existing admission limits are not autoscaling. Automatic draining, runner failover and unlimited-demand capacity are not implemented by this patch.

The encrypted checkpoint limit remains 20 MiB. Losing the host of a larger session can lose progress since its last valid checkpoint. Removing a pinned runner requires migrating/draining its sessions first. Existing native background jobs are not adopted into the tracked registry; the tool restrictions apply to new Claude processes.

Before restarting an existing runner API, apply `KillMode=process` to its systemd unit and reload the unit configuration. Otherwise the old unit can kill detached agents on restart. Ship the matching runner server/cleanup files as well as the Worker changes before enabling AWS execution. Read-only signed diagnostics succeeded on both existing AWS runners: both still report `KillMode=control-group` and zero active SDK wrapper processes. EC2 reports both instances running without an SSM instance profile; the configured AWS identity is denied SSM inspection. These diagnostics did not apply the new unit or restart either service. Python urllib received HTTP 403 even for public health requests in this environment, while curl public-health and signed-exec requests succeeded; that 403 is not evidence of a rejected runner signing key.

No production settings were changed, no runners restarted, and no live Claude inference or production fault injection was performed for this follow-up. No zero-interruption guarantee follows from these checks.

The public harness has no hosted Claude MCP bridge/runner placement equivalent. The generic tmux installer fix should be considered if its snapshot contains analogous code; no public-repo port or npm publish was performed.

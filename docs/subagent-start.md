# Starting a helper (the `agent` tool)

Path: `subagentTools` agent tool -> `spawnSubagent` (src/server/services/subagent-tools.ts)
-> `subagentAdmission` -> `openTask` (one `agent_session` row) -> `saveSpec` ->
writer: `fork` + `saveProviderRef` + `mergeFork` -> `start` =
`startPreparedAgentTask` (harness-workspace-session.ts): `prepareAgentTaskStart`
(`reserveAgentTaskStart`, agent-capacity.ts) then the first send (queues the
first `api_turn`). The VM binding (`bindAgentSessionMachine`) runs later, in the
api-turn job, not on this path; its failures reach the helper as an error item.

## Failure stages

`SubagentStartStage` (src/domain/subagent-start.ts): `open`, `save-spec`, `fork`,
`reserve`, `enqueue-first-turn`, `unknown`. `reserve` and `enqueue-first-turn`
are mapped inside `startPreparedAgentTask`; the others are named by the stage
`spawnSubagent` was in when the call threw.

## Retry policy

- Up to 3 attempts; waits of 400 ms then 1200 ms (`SUBAGENT_START_BACKOFF_MS`).
- Only retryable failures: timeouts, ECONNRESET/socket, 5xx, 429, "busy"/lease/
  lock races, refused copy, "provider didn't say why". Permanent causes win
  (admission, budget, depth, usage caps, bad input, "already running"), and
  admission runs before any attempt, so it is never retried.
- Idempotent: one helper row (`openTask` runs once), the spec is saved once, a
  finished fork VM and its saved record are reused, and a failed reservation is
  released (`releaseAgentTaskStart`, back to `draft`) before the next attempt. If
  the release finds a queued turn, the first send got through: that counts as
  started. Nothing is charged twice: budget is counted from the tree's usage.
- Success after a retry shows nothing about the earlier failure.

## What the user and the model see

After the last attempt: `Couldn't start the helper (<plain reason>). I retried 3
times. Try again in a moment; nothing was changed.` (flagged `retryable`; the
row is marked failed). The helper card reads "Couldn't start" (muted) when the
helper never did any work. Effect's default text is rewritten at the tool-error
boundary (model-agent-loop.ts) and in `failureMessage` to "Something went wrong
on our side. It's been logged; try again." plus `(stage: x)` when known.

## Log

One `console.warn("subagent.start_failed", { stage, retryable, attempt, cause })`
per failed attempt. `cause` is the original message only (truncated, token-like
strings redacted); no brief, title or other user content.

## Still unmapped on the neighbouring paths (not changed)

`harness-workspace-session.ts` `sendHarnessWorkspaceTask`: `send:chat`,
`send:claim`, `send:branch` and a fourth tryPromise (user sends, not helper
starts). `project-workspace.ts`: lines ~78, 91, 117, 159, 173, 188, 329.
`src/server/services/subagent-start-path.test.ts` guards the start function.

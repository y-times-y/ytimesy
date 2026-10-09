# Coordinator failure reporting and evaluation isolation

## Reproduced defect

The adapter collapsed HTTP 401, 403 and exhausted 503 renewals into
`Error / unknown`. The new 503 classification regression failed before the fix.
When a renewal failure aborted inference, the worker subsequently attributed
the error to the model stream rather than preserving the coordinator failure.
The exact HTTP/transport cause of the earlier live failure cannot be recovered
from its old generic log; these changes do not retroactively establish it.

## Changes

- Coordination failures retain action, attempt count and HTTP status or bounded
  timeout/network category. Response bodies, URLs, raw causes and credentials
  never enter the diagnostic record.
- Worker completion records the coordinator failure as primary after a renewal
  abort, reports a safe actionable message, stops commands and refuses publication.
- Evaluation runs start the existing production Durable Object locally through
  the installed Wrangler runtime. Fresh signing secrets and private temporary
  SQLite storage replace inherited remote configuration and development fallback.
  Acquire/renew/release preflight precedes VM preparation and inference. Cleanup
  stops the owned coordinator, deletes its temporary storage and restores env.
- Lease fencing is unchanged: 409 is not retried; renewal has at most two
  identity-bound requests; other actions have one. No stream replay, relaxed
  deadline, alternate orchestration loop or model fallback was introduced.

## Verification boundaries

Tests use the actual local Workerd/SQLite-backed Durable Object and signed
production adapter, not a reimplementation of its lease rules. They cover parent
lease release/reacquisition, independent child leases, conflicting writers,
incorrect signatures, cancellation, retired replay, real 30-second expiry and
preflight failure cleanup. A resumed production turn handler with mocked model,
database and repository services receives injected HTTP 503 renewals: it stops
commands, records the primary error, skips commit and retires its lease.
The separate notification suite verifies idle wakeup and active mailbox behavior.
This is not an end-to-end production queue or paid provider test.

Validation commands:

```sh
pnpm exec vitest run tests/api-turns.test.ts src/server/adapters/api-turns.test.ts src/server/services/agent-task-event-delivery.test.ts src/server/services/agent-child-supervision.test.ts src/domain/child-supervision.test.ts src/server/jobs/api-turn.test.ts src/domain/api-turn-failure.test.ts tests/realtime-worker.test.ts tests/evaluation-coordination.test.ts src/server/adapters/conversation-turn-control.test.ts
pnpm run typecheck
pnpm run build
git diff --check
```

All 101 tests across the ten targeted files passed. Typecheck (including workflow
types), production build, focused Biome checks and diff whitespace checks passed.
Focused Biome checks cover every source/test file changed in this repair. No paid inference,
Freestyle resources, remote migration, deployment, commit or push was performed.
No new benchmark ran and no speed/token/code-quality advantage is claimed.

The [Cloudflare testing documentation](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
was checked before implementation. The existing Wrangler-based local runtime
tests were reused instead of introducing a second test runtime or dependency.

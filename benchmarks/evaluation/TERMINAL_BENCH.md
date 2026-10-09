# Private Terminal-Bench diagnostic

This bridge evaluates the application harness, not an alternate benchmark-only
model loop. Harbor launches the application's production job worker with an
isolated `WorkspaceMachines` adapter. Delegation, tools, review, accepted patches,
and turn limits still use the existing application services.

## Scope

The initial diagnostic permits only `session-window-debug`,
`wal-recovery-ordering`, and `nextjs-performance`, with `gpt-6.1-sol`, maximum
reasoning, and fast mode disabled. Each attempt is capped at 30 minutes, 100 model
requests, and four million observed tokens. These shorter limits are not the
public leaderboard protocol. Three selected tasks cannot establish general
superiority over another harness.

The operator needs Docker, Node/tsx, a Python environment with Harbor, the linked
development credential source, private checkpoint storage, and explicit approval
for subscription inference and disposable Freestyle resources. No always-on
worker is provisioned.

## Isolation

- Start the production Durable Object coordinator locally with a fresh signing
  secret and private temporary SQLite storage. Explicit loopback configuration
  overrides inherited remote configuration and the development fallback file.
  Signed acquire/renew/release preflight must pass before provisioning or inference.
  Keep the existing lease conflict, expiry and cancellation fences; never bypass
  coordination to obtain a benchmark result. Stop the coordinator and remove its
  owned storage on success or failure.
- Copy one operator's access-only Codex credential into an ephemeral, loopback
  PostgreSQL database. Do not copy the refresh token, GitHub credentials, or job
  queue. Migrations run only against this disposable database.
- Keep credentials in the operator process, outside the task machines. Each
  agent machine runs the task's pinned image and permitted sidecars.
- Do not expose `tests/` or `solution/` to model inference. Grade only the reviewed,
  accepted artifact from the production task tree.
- Keep tasks, logs, resource ledgers, protocol records, and results under the
  ignored `.ytimesy/terminal-bench-pilot/` directory. Do not upload results or
  commit task assets or private evidence.
- Delete only resources registered to that attempt. Cleanup reports are separate
  from scores; inspect the ownership ledger if cleanup fails.

## Verification

Before inference, verify baseline failure and official reference success using
unmodified hidden tests. Next.js timing controls must run on native Linux: the
official reference failed its timing threshold under local macOS Docker and
passed on a separate Freestyle Linux verifier. Its custom Harbor verifier runs
the same original tests on that Linux environment, without model credentials.

`scripts/evaluate-terminal-bench.ts` supports a zero-inference `preflight` mode
that checks storage, task provisioning, and a real fresh child workspace.
`scripts/grade-terminal-bench.ts` grades an already exported artifact without
inference. The proof scripts exercise Docker, snapshots, artifact export, and
the native verifier independently.

The Harbor adapter is
`benchmarks.evaluation.terminal_bench_agent:YtimesyTerminalBenchAgent`.
The Next.js verifier is
`benchmarks.evaluation.terminal_bench_agent:YtimesyNativeLinuxVerifier`.
Both require the absolute application path; the agent also requires the absolute
task path. Run one attempt at a time unless a separately approved protocol allows
otherwise. Set `YTIMESY_EVALUATION_APPROVED=codex-subscription` only after approval.

## Reading results

Report setup time, agent time, verifier time, infrastructure errors, code scores,
and cleanup independently. A Harbor exception is not a hidden-test score of zero.
Record every failed attempt rather than reporting only successful retries.

Usage records are cumulative within each turn. Count the current request's last
usage record once; reject missing metrics rather than borrowing earlier usage.
Failed requests can omit provider usage, so observed guard counters are not
necessarily complete billing totals. Freestyle invoice charges must be checked
separately; resource caps alone do not prove an exact dollar spend.

The protocol records HEAD and the tracked working-tree diff hash, but does not
hash untracked adapter source. Preserve the source snapshot alongside private
results before treating a run as reproducible. The adapter rejects symlink and
special-file artifacts and currently supports only the three selected task
contracts; it is not yet a general-purpose Terminal-Bench runner.

# Claude-inspired harness verification — 2026-10-06

Scope: `codex/claude-harness-gaps`, implementation commit `80fae50` plus the
returned-failure hook correction from this verification. No permission layer,
schema migration, deployment, paid inference, or sibling-worktree changes.

## Findings and correction

Review found that returned failure receipts triggered PostToolUse instead of
PostToolUseFailure. This affects native patch rejections, nonzero command exits,
and `{ok:false}` responses. Hooks now reuse the existing `reportedToolFailure`
classifier and preserve the original receipt. A regression test verifies all
three forms. Thrown failures already dispatched correctly.

## Fresh checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `pnpm exec vitest run --maxWorkers=2` | 298 files passed; 1,552 tests passed, five skipped | Local unit/integration contracts, including PGlite recovery/fork/owner checks, real Git files and mock model-loop wiring |
| `pnpm harness:regression` | 67 passed, three skipped | Focused context, hooks, recovery, process-scope and evaluator regressions |
| `pnpm typecheck` | Passed | Application and workflow types |
| `pnpm lint` | Passed | Repository checks, including the Linux proof script |
| `pnpm build` | Passed | Client/server production bundling |
| Actual Linux smoke script | Passed | Real Git, Python, shell, `/proc` process fence and artifact capture; no fence mock |
| agent-browser recovery fixture | Passed | Actual component expands, dispatches fork, shows retry errors, and disables controls for running turns; conversation-only controls omit code recovery |
| Configured PostgreSQL, read-only | Passed | Required tables exist; recovery/fork insert plans, continuation query and session-column queries are compatible with the live schema |
| Freestyle VM list, read-only | Four VMs, all paused | Provider access works; no VM was started or modified |

The Linux smoke ran in a disposable existing Linux/amd64 image using Node 24.12.0,
with networking disabled and only the generated proof bundle mounted read-only.
It used a temporary repository, not an application checkout or user session.
The following paths passed:

- Scoped instructions reach the model context before the first edit; retry performs
  the real edit. Earlier read evidence becomes stale and root instructions reload
  after compaction.
- Git rewind restores the saved contents; restoring the backup recovers later edits.
- Baseline-pinned PostToolUse, PostToolUseFailure, PostCompact and Stop commands run
  through the actual process fence/output capture. Replayed calls run a hook once;
  returned failure receipts keep their original contents and reach the failure hook.
- A TERM-resistant process is stopped, its output stops changing, and later commands
  for that stopped turn are rejected.

The smoke's replay journal is in memory. Durable database-journal behavior is
verified separately by the repository tests; this is not a live worker restart
proof. Linux-only tests skipped on macOS are not claimed as executed there.

The live PostgreSQL check resolved the existing configured CA path without
disabling certificate verification, used a read-only transaction, and rolled it
back. EXPLAIN planned inserts without executing them. It read no user records and
created no user, session, receipt or migration.

## Reproduction

On Linux with the repository dependencies, Git, Python 3 and Bash available:

```sh
pnpm exec tsx scripts/prove-claude-harness-linux.ts
```

This script creates and cleans up only its own temporary repository. It performs
no model requests and needs no provider/database credentials. The PR regression
workflow now runs it and uploads its JSON output alongside the JUnit results.
The workflow has been inspected locally; its hosted GitHub run remains unverified.

## Remaining boundaries

These results verify the implemented custom Codex-subscription/API harness batch,
not complete Claude Code parity. Full `.claude/rules` frontmatter behavior and an
automatic recovery-undo button remain outside this implementation. The native
Claude Code adapter retains its own runtime behavior.

No authenticated browser-to-worker-to-provider session, remote code recovery,
actual model compliance, cloud restart/cancellation, or competitive speed/quality
benchmark was executed. Local mocks, the browser fixture, Linux smoke, and
read-only schema checks do not establish those outcomes.

The existing [PLAN.md](../../PLAN.md) says:
“Do not start Freestyle VMs until that allowance resets.” This run did not
establish that reset, so it preserved all paused VMs. The public VM API exposes no
account-usage endpoint in the inspected contract. Cloud end-to-end verification
therefore remains outstanding; no new permission rule was added.

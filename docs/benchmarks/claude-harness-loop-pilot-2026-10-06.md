# Claude-inspired harness loop pilot — 2026-10-06

The batch showed a narrow stale-source recovery efficiency gain, but **no overall
quality or efficiency gain in this small pilot**. Both versions passed all four
independent graders. Summed agent-loop wall time increased **12.0%** and
input plus output tokens increased **28.3%**. One run per case provides
observations, not a statistically established effect.

## Valid paired results

All pairs used gpt-6.1-sol, Low reasoning, identical task prompts, fixture files,
tool availability, isolated Linux environments, and independent grading checks.

| Task | Before / After grade | Before / After wall time | Before / After total tokens | Before / After requests |
| --- | --- | --- | --- | --- |
| ordinary-bug | Pass / Pass | 20.6s / 28.1s | 11,546 / 16,454 | 5 / 6 |
| nested-guidance | Pass / Pass | 25.1s / 23.9s | 11,667 / 16,737 | 5 / 6 |
| stale-source | Pass / Pass | 29.5s / 21.6s | 14,466 / 13,084 | 7 / 6 |
| completion-hook | Pass / Pass | 22.8s / 36.1s | 12,564 / 18,191 | 5 / 6 |
| **Total** | **4/4 / 4/4** | **98.0s / 109.7s** | **50,243 / 64,466** | **22 / 24** |

Total tokens include cached input and output; they are not a dollar-cost estimate.
Uncached input totals were 15,615 before and
18,061 after. Cache routing and model variation are further
reasons to avoid extrapolating dollar costs from this pilot. All valid runs ended
normally, with zero model-visible tool failures. Runtime-issued guidance reads and
freshness checks are additional operations; the model tool-call metric excludes
those automatic operations. The new arm issued 88 guest execution calls versus
49 in the baseline, including preflight and automatic checks. This is a concrete
overhead signal, not an attribution of every timing difference.

## What the traces establish

- **Stale source:** an identical external writer changed configuration after its
  first structured read. The baseline initially wrote an obsolete snapshot, then
  reread and repaired it. The new runtime supplied a hash-based freshness notice;
  the model reread before writing its snapshot. Both passed. The new run took
  26.7% less wall time, used 9.6% fewer total tokens, made one fewer inference
  request (7 to 6), and avoided one artifact write (2 to 1). This is an observed
  recovery benefit in a synthetic race, with explicit source-change awareness in
  the common task prompt.
- **Ordinary bug:** both passed. The new run performed additional edge-case work
  and took longer. The difference includes model-selected work, not just runtime
  bookkeeping, so it cannot all be attributed to context-check overhead.
- **Nested guidance:** both preserved the alias and handled the requested inputs.
  Automatic instruction loading worked. Slightly lower wall time accompanied
  higher token use; no success-rate advantage was demonstrated.
- **Completion hook:** both refreshed the required manifest. The new runtime's
  baseline-pinned Stop check executed successfully; it requested **zero**
  continuations. The baseline followed the written workflow independently. This
  proves execution on the live model path, not incremental recovery from a
  skipped completion step. The new run was slower and used more tokens.

## Protocol and evidence boundaries

Before: `d7b80952ee61b56e7b627e46a5a403431ab085c3`.
After: `755ee5e07d7203289477e980efcc4d429f9c0570`.
Task-set SHA-256: `3d547f60f0aea485efaf7d7d4bce6b3a569368b55e0e8b9ecc06265c0669a53c`.

The before sources were a clean Git archive, with their own package/TypeScript
resolution. Both arms shared installed dependency versions. Execution used the
actual versioned `runModelAgent`, file tools, repository-guidance tool, and managed
Codex subscription adapter. The new arm additionally used the actual automatic
repository context and lifecycle hook services. Generic workspace execution was
implemented by a disposable Docker adapter, not a Freestyle worker.

Docker image: `sha256:43ce618452b29610b682ea77e384dcb8c57308957a7eb65734a47d76a7ff47dc`. Linux/amd64, Node 24.12.0,
network disabled, one CPU, 512 MiB, dropped capabilities, no credential mounts.
Each attempt received a fresh repository and cache scope. The fixed eight-tool
surface included file reads, listing, creation, replacement, shell verification,
repository guidance and change inspection. Each attempt had an eight-request
budget, 2,048 output tokens per request, and a 150-second timeout. Cases ran
sequentially with both arm orders: stale-source AB, ordinary-bug AB,
nested-guidance BA, completion-hook BA. No task or grading condition was changed
after initial definition. Graders ran after inference and were not mounted into
the model's repository. Wall time includes model-loop preparation, model calls,
tool execution and Stop checks; it excludes container provisioning, connection
setup and independent grading.

This is **not** a native Claude Code/Codex comparison, SWE-bench result, full cloud
orchestration benchmark, or evidence of production deployment. It did not measure
compaction under long contexts, task delegation, review/import, forks, checkpoint
rewinds, authenticated UI workflows, or the separate Cursor/Oh My Pi worktrees.

## Infrastructure audit and resource use

Initial trials exposed two errors in the benchmark adapter: an incorrect callback
name before inference and missing `WorkspaceMachines.writeTextFile`, which forced
model recovery through shell commands. Those comparisons were excluded. The
corrected adapter completed a real file-tool upload/edit preflight before each
valid attempt. The task content remained fixed; the common tool surface was
reduced to lower inference payload. Four completed invalid trials, one pre-inference
setup failure, and one interrupted infrastructure trial are retained separately.

Usage events from the loop are cumulative. The first observer incorrectly added
them repeatedly. Final measurements were reconstructed from the final cumulative
event and cross-checked against the sum of individual request metrics. The campaign
briefly paused on that overstated token ceiling; correcting its counter allowed
the last pair to finish. This was a measurement correction, with no inference
retry or task change. The saved protocol records both corrections.

Valid comparisons used **114,709 measured tokens**.
Discarded completed trials used **84,700** measured tokens; known measured total
was **199,409**, plus any unrecorded usage from
the interrupted trial. No API-key inference or cloud VM was used: the run consumed
the existing Codex subscription. Exact marginal dollar cost is not available.
Shared weekly usage moved from 87% to 90%; it is rounded, account-wide, and includes
concurrent activity, so that change cannot be attributed solely to this run.
Further inference stopped at the 90% boundary; no repetitions were attempted.

All owned containers were removed. No production deployment, main checkout change,
sibling-worktree modification or cloud VM start occurred.

The sanitized result ledger is
[claude-harness-loop-pilot-2026-10-06.json](claude-harness-loop-pilot-2026-10-06.json).
Private fixtures, grading code, full traces, protocol amendments, adapter scripts
and excluded trials remain in the ignored `.ytimesy/benchmark/` directory of this
worktree. They are excluded from commits.

## Decision

Keep the correctness/recovery safeguards on their merits, but do not describe this
batch as a general speed, cost or success-rate improvement. The next useful
optimization is reducing automatic evidence-check/tool-execution overhead, then
rerunning broader real-repository cases with repeated pairs. That optimization
was not undertaken or verified in this measurement request.

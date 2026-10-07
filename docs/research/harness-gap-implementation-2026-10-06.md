# Harness gap implementation

## Scope and isolation

User-approved scope excludes automatic model selection and empirical per-model
tuning. Work is isolated on `codex/harness-remaining-gaps` at
`/Users/hetpatel/.codex/worktrees/harness-remaining-gaps/cloud`.

The original checkout was dirty and another agent was using it. Commit
`e3724b9` is the imported baseline, not this implementation. Review subsequent
changes against that commit. No original checkout, server, production database,
deployment, or paid evaluation infrastructure was modified.

## Implemented Batch

- Local SQLite FTS5 trigram candidate index for eligible literal searches and
  plain ASCII identifiers in default Git basic-regex mode. Whole-word matching
  is available with `wordBoundary:true` and is confirmed by Git, not inferred
  from tokenizer boundaries. Actual regex syntax still falls back to Git.
  Refreshes metadata and changed contents before querying. Git still owns final
  matching, exclusions, filename formatting, and exit codes. Regex syntax, short,
  non-ASCII, oversized repositories, unsupported SQLite builds, index failures,
  and concurrent inventory changes fall back to Git. No embeddings or external
  index upload. Private cache is outside the checkout. This is not Cursor's
  proprietary Instant Grep implementation or a proven performance improvement.
  Corpora below 16 MiB remain on Git; index eligibility is bounded to 16-64 MiB.
  This conservative routing boundary avoids index refresh cost on small trees;
  it is not a measured crossover point or a large-repository speed guarantee.
  Runtime indexing is opt-in with `YTIMESY_INDEXED_SEARCH_ENABLED=1`. The default
  executes native Git directly without Python startup or inventory overhead.
  No flag was enabled here. Index acceleration is an experimental capability,
  not an absorbed or measured competitive advantage.
- Warm project/language servers over private Unix sockets, using maintained
  `vscode-jsonrpc` transport. Document versions are refreshed on requests;
  initialization is shared. Requests serialize, stalled servers are terminated,
  and idle servers expire after one minute. TS/JS tooling remains pinned;
  Python/Rust/Go still require their configured server binaries in the guest.
- Post-write feedback from already-warm language servers. Cold edits do not
  install or start a language server. Missing feedback is explicit and never
  erases a successful edit receipt. A cold eight-file same-language batch probes
  once. File deletion closes an open document. Observed diagnostics are not a
  project-check receipt; servers omitting diagnostic versions cannot establish
  source-bound freshness.
- Recoverable superseded complete `read_file`/`read_files` bodies. Exact older
  history is archived before replacement. Latest bodies and call/result identity
  remain intact. Partial reads do not supersede full evidence. Archive failure
  preserves original history. Existing provider-prefix restrictions remain.
  Earlier completed user turns also retire large captured command/search/list
  bodies, check logs, and output pages into previews after exact archival. Exit,
  stop, source-verification and paging metadata remain unchanged. Current-turn
  outputs, unknown tools and small bodies remain intact. These previews are
  explicitly incomplete historical evidence, with exact archive recovery.
  This is not blanket removal of arbitrary tool output within an active turn.
- Background native compaction for the known unbound OpenAI route. It overlaps
  a tool step, freezes only earlier completed user turns, preserves the live
  turn, meters native usage, and adopts only a matching exact prefix. Failed,
  stale, empty, oversized, or unarchivable checkpoints preserve original history.
  Pending compaction is settled/cancelled before the runtime returns. Bound or
  unknown provider contracts and text-only fallback compaction remain serial.
- Dedicated task-owned Node debugger using Node's maintained inspector in a
  worker thread and JSON-RPC socket transport. Supports breakpoints/removal,
  pause/continue, stepping, stack and local/module variables. No expression
  evaluation, getter execution, or external-process attachment. Read-only leads
  do not receive this tool. Its detached application process is registered with
  the existing Linux turn fence, and has a five-minute idle expiry. Other runtime
  debuggers are not implemented. Debug logs and frames explicitly mark truncation.

## Remaining Work

These are still execution or rollout work, not established advantages:

1. Continuous PR-repair rollout and end-to-end proof. Repair machinery already
   exists in the imported baseline; it remains disabled without explicit runtime
   configuration and deployed worker/webhook infrastructure. No flag was flipped
   and no paid or production execution was started here.
2. Representative paired evaluation execution. Existing evaluation runners and
   the new campaign sampling/preflight guard are available, but selecting real
   independent tasks and running them under controlled conditions remains.
   Tests/builds do not prove harness speed,
   quality, cost improvements, or live reliability.

## Verification Boundaries

Local fixtures exercise real Git/SQLite, a real TypeScript language server, and
a real Node inspector process. Context/state tests use mock inference and make
no provider-performance claim. Linux `/proc` PID-start fencing is wired to the
existing mechanism but is not a live Freestyle VM proof from this macOS run.
Production activation, migrations, paid paired campaigns, and other language
debuggers are not verified.

Local verification: full suite passed 286 files and 1,500 tests, with five
pre-existing skips. Production build, application TypeScript, workflow
TypeScript, changed-file Biome checks, and `git diff --check` passed. The stronger
compaction fixture uses a discovered executable tool and mutually waits for
both the tool and compactor to start, proving actual overlap in the mock runtime
rather than relying on callback names. The final socket-identity hardening also
passed the real language-server fixture separately.

## Follow-up Batch

The first implementation is committed as `b80a0c2`. Follow-up tests additionally
exercise real default-regex identifier indexing, exact Git word boundaries,
historical failure/stop preservation, archive failure, idempotent retirement,
check-batch source metadata, Unicode previews and runtime bound-prefix exclusion.
This is implementation coverage, not a measured Cursor performance comparison.

Final follow-up validation passed 287 test files and 1,510 tests, with five
pre-existing skips. Full repository Biome lint, application/workflow TypeScript,
production build, and `git diff --check` passed. The native search fallback was
also executed with hostile shell-looking query text; no injected command ran.

A local five-repetition search timing check on this checkout compared exact
outputs for `agentSessionForOwner` and `runModelAgentStep`. Direct Git took
21-74 ms; the initially ungated index took 2,391 ms cold and 118-413 ms warm.
These timings ran while regression tests were active and are not a controlled
benchmark. They still expose overhead, not a demonstrated speed advantage.
Default routing now avoids both index startup and inventory overhead. The opt-in
indexed route still inventories corpora before falling back on small trees;
further performance work and large-repository evaluation remain.

## Completion and Scheduling Batch

- Writable task completion now requires baseline-selected checks before commit,
  publication, completed status, or exact-patch acceptance. The control plane
  pins the pristine initial Git baseline in its owner-scoped command journal.
  Guest ref redefinition is rejected. Explicit user branch selection atomically
  retires the prior baseline and completion receipts. Legacy dirty checkouts
  without a pinned baseline fail closed and retain their edits.
- Real command exits, stops and full-output references are retained. The entire
  Git tree, including new nonignored files, and exact binary patch are compared
  before/after checks; commit-time and post-hook tree checks prevent acceptance
  of a later mutation. Unchanged work is not a passing verification receipt.
  Interrupted attempts are not replayed. A failed gate preserves the checkout
  for a new repair turn, rather than automatically invoking another model.
- Changing verification recipes or package scripts requires a separately
  approved pristine baseline. Dependency/lockfile edits alone do not redefine
  the check contract. Unconfigured projects need an explicit recipe or baseline
  test script. This is not a protected external grader: ignored dependencies,
  runtime environment, guest Git object storage and test semantics remain
  outside the Git-tree freshness guarantee. Integration now executes its
  baseline checks through the universal gate, retaining the existing progress
  and output capture. The commit gate reuses the resulting server-owned receipt
  only for the exact unchanged whole tree and complete required command set,
  avoiding a second baseline-check run. Additional lead-defined checks remain
  separate; they do not substitute for baseline checks.
- `schedule_task_plan` persists up to twelve existing fresh writable API/Codex
  drafts with fixed selected models. Critical-path priorities reuse the advisory
  planner. Claims and heartbeats use the existing journal; pg-boss supplies a
  durable queue and minute reconciliation backstop. Atomic admission also binds
  the draft contract, preventing a changed model/prompt/dependency from launching
  between inspection and reservation. No database migration was added.
- Dependencies require completion and exact-hash lead review. Single parents
  use stacked tasks. Explicit integration nodes combine two to eight reviewed
  sibling patches without inference, recapture their exact identities, run
  checks and retain a separately reviewable join. The join is not accepted
  automatically. Independent ownership declarations are planning metadata,
  not a filesystem sandbox. Claude native drafts are not supported by this
  durable dispatcher because it relies on durable API-turn acceptance evidence.
- Restart recovery observes queued turns or actual completion, never treats
  an admission reservation as accepted inference, and blocks uncertain launches.
  `read_task_plan` exposes preserved state; pause/cancel fences future dispatch.
  Already started model tasks require their separate stop controls. Blocked
  work cannot bypass uncertainty through pause/resume. Blocked notifications
  reuse the task-event outbox without rewriting partial child runtime state.
- Campaign preflight requires twelve distinct development problems across at
  least three repositories, with two repetitions and two tasks each for
  navigation, repair, multi-file, verification, coordination and long-context.
  It rejects renamed duplicate problems and final holdouts, retains fixed model,
  source, verifier and image pins, and prepares private manifests without
  inference. These are sampling guardrails, not statistical power or a result.

The prior signed PR-delivery proof is recorded in
`benchmarks/evaluation/VERIFICATION-2026-10-05.md`: it demonstrated durable
delivery and deduplication with zero inference. It did not demonstrate a model
fixing a PR, and is not new live verification from this worktree. Continuous
repair, paid evaluation and production activation remain disabled here.

Final local regression validation passed 294 files and 1,539 tests, with five
pre-existing skips. A preceding full run encountered an existing tmux fixture's
interrupted-command result; its isolated rerun and subsequent full reruns passed.
This was not established as a specific harness bug, and no unrelated production
code or assertion was weakened to hide it. Final focused checks after receipt
inspection/prompt-size hardening passed 35 tests. Full lint, application/workflow
typechecks, production build and diff whitespace checks passed. Real Git and
PostgreSQL-compatible fixtures verify baseline ownership, whole-tree mutations,
check/commit failures, exclusive plan claims, contract-bound admission and
blocked notification deduplication. They do not constitute live Linux execution,
model performance, or a production rollout. The original checkout remains
untouched and no migrations, pushes or paid/cloud runs were performed.

## Follow-Up: Integration Reuse And Search Cost

The integration executor is an internal server callback, not a model-supplied
receipt endpoint. The gate still selects commands from the pinned baseline,
validates exact command names, zero exits, null stops and UUID output references,
owns the verification journal, and compares the complete checkout before and
after checks. New real-Git fixtures prove callback execution, exact-tree reuse,
rejection of mismatched command receipts, and rejection of new undeclared files.
Integration fixtures prove a failed whole-checkout gate prevents commit.

The experimental search cache now uses SQLite's positionless FTS5 trigrams and
stable row IDs for refresh/deletion. This removes repeated full-content table
scans during construction and refresh. A required three-character substring
selects a superset of candidates; native Git still owns exact matching, regex
fallback, word boundaries, output and exclusions. Disposable legacy caches are
rebuilt transactionally. Git remains the default and the index remains opt-in.

Reproduce the zero-inference synthetic test with
`pnpm exec tsx scripts/benchmark-repository-search.ts 16 32 64`.
Each corpus has exactly the stated ASCII bytes, 64 KiB code-shaped files and a
rare marker. Every cold, warm, edited and absent query compares stdout, stderr
and exit status with Git. Files and caches are removed afterward.

Observed sequential local timings in milliseconds on this macOS machine:

| Corpus | Previous Cold Index | Revised Cold Index | Revised Warm Index (3 Runs) | Git Warm (3 Runs) |
| --- | --- | --- | --- | --- |
| 16 MiB / 256 files | 2653 | 632 | 89-92 | 23-24 |
| 32 MiB / 512 files | 5191 | 1192 | 93-103 | 29-30 |
| 64 MiB / 1024 files | 8128, refresh rolled back | 2656 | 116-127 | 43-59 |

The previous 64 MiB cache exceeded its refresh budget on every sampled query
and fell back to Git with no persisted files. The revised cache indexed all
1,024 files. All 18 revised comparisons were identical to Git. Revised edited
queries took 94/103/126 ms versus Git's 24/29/44 ms. This improves experimental
index construction, but does not show a search-speed advantage over Git.
Python startup, complete inventory and validation overhead remain. Synthetic
code, shared-machine timing and three warm repetitions are not representative
agent benchmarks, statistical confidence, or a Cursor comparison. An initial
benchmark version accidentally exceeded the 64 MiB limit by its appended
marker; that fixture was corrected before the table above was collected.

Follow-up focused tests passed 38 tests, then the full regression suite passed
294 files and 1,542 tests with five pre-existing skips under the normal test
timeouts. Application TypeScript, full lint, production build and diff whitespace
checks passed. The first combined
focused run hit a five-second real-process fixture
timeout; an isolated single-worker run passed, followed by the expanded search
fixtures. This does not establish the cause of the timing variation.

## Subsequent Live Proof

With fresh user approval capped at $10, the actual baseline, completion receipt,
commit fence and Linux process-cancellation services passed disposable Freestyle
and development PostgreSQL probes. A fixed-model direct operator invocation of
the production model/tool loop repaired one tiny synthetic fixture in 18.7
seconds and passed 12 independent post-run assertions. The durable worker,
full lead/builder pipeline and PR repair were not exercised. Failed proof-adapter
attempts are retained rather than counted as passes.

All 18 synthetic Linux search comparisons matched Git, but no consistent
indexed-search speed advantage was observed, so the index remains opt-in.
All proof-owned VMs and database fixtures were confirmed removed; shared worker
and concurrent-agent resources were preserved. Five bounded small VMs, including
failed attempts, had an aggregate maximum standard-rate compute/storage envelope
below $0.12, not invoice-reconciled total spend. See the complete conditions,
failures, limitations and reproduction commands in
[the live proof](../../benchmarks/evaluation/VERIFICATION-2026-10-06-HARNESS-MECHANICS.md).
This is functional proof, not Cursor parity or representative model performance.

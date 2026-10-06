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

- Local SQLite FTS5 trigram candidate index for eligible literal searches.
  Refreshes metadata and changed contents before querying. Git still owns final
  matching, exclusions, filename formatting, and exit codes. Regex, short,
  non-ASCII, oversized repositories, unsupported SQLite builds, index failures,
  and concurrent inventory changes fall back to Git. No embeddings or external
  index upload. Private cache is outside the checkout. This is not Cursor's
  proprietary Instant Grep implementation or a proven performance improvement.
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
  Arbitrary command-output retirement is not yet implemented.
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

These are still implementation work, not completed features:

1. Durable dependency-plan dispatch: persist bounded plans, claim ready nodes,
   retain partial/uncertain launches across restarts, enforce account admission,
   and require exact reviewed integration for multi-prerequisite joins. Reuse
   existing task creation, admission, review, command receipts, and pg-boss.
2. Mandatory authoritative completion gate for every writable builder: derive
   checks from the clean baseline, retain real receipts, bind all relevant
   sources before/after verification, and reject uncertain/stale/no-op evidence.
   Existing background-command fencing and reviewed-integration checks are not
   universal baseline verification. Model-authored `run_checks` alone is not an
   authoritative contract.
3. Continuous PR-repair rollout and end-to-end proof. Repair machinery already
   exists in the imported baseline; it remains disabled without explicit runtime
   configuration and deployed worker/webhook infrastructure. No flag was flipped
   and no paid or production execution was started here.
4. Representative paired evaluation campaign. Existing evaluation runners and
   regression gates are available, but implementing a campaign and running it
   under controlled conditions remains. Tests/builds do not prove harness speed,
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

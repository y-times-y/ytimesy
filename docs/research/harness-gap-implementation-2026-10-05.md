# Harness gap implementation — 2026-10-05

## Acceptance boundary

The goal is less developer time, lower cost, and better code—not the largest tool catalog. The [source audit](harness-gap-audit-2026-10-05.md) identifies mechanisms; the [reuse investigation](harness-reuse-2026-10-05.md) records maintained integrations. Neither proves competitive superiority. Proprietary implementations are not reproducible specifications.

Preserved: read-only leader, isolated writable builders, owner-scoped subscriptions/BYOK, independent builders running concurrently, no silent inference fallback, durable receipts, exact combined-diff review, and complete required integration checks. No Cursor branch was merged.

## Gap-to-implementation map

| Gap | Implementation | Evidence and boundary |
| --- | --- | --- |
| Model-aligned editing | Official OpenAI `apply_patch` tool and maintained V4A parser; generic V4A and exact unique text replacement remain available. Atomic writes compare inspected source hashes under a repository lock. | Real local Git/filesystem tests cover create/update/delete, stale-source rejection, receipt replay, traversal, symlinks, CRLF and failure serialization. Native provider wire contract is tested locally; live backend acceptance is not yet verified. |
| Overloaded prompts and tool definitions | Concise builder role guidance; AI SDK deferred tool discovery; discovered names restore from durable receipts after restart/compaction. Repository-scoped instruction discovery and deferred skill bodies. | Real SDK mock-model execution tests verify schema exposure and metrics. Discovery cannot introduce tools absent from the authorized registry. Full-schema context budgeting remains conservative. |
| Lost output and incomplete search | Session-owned stdout/stderr artifacts with Unicode page cursors; tracked and nonignored untracked Git search without per-file match cutoff; bounded background-command waiting. | Actual Git, Python and tmux tests—not provider mocks—verify search injection safety, Unicode paging, completion status and output limits. Linux process ownership has separate tests; macOS tmux tests do not prove Linux isolation. Artifacts are VM-local; output beyond the explicit 16 MiB-per-stream cap is incomplete, never represented as complete. |
| Stale project context | Project Markdown entries carry checkout revision and tracked source hashes; an inspection tool verifies freshness in the current checkout. | Actual repository tests invalidate evidence on dirty state, changed HEAD or source hash. Credentials/untracked secret files cannot become source evidence. Freshness is not proof that a claim is semantically correct or that its tests passed. |
| Slow edit feedback | TypeScript compiler syntax diagnostics immediately after supported small edits. | No code execution; declaration files and unsupported/large sources explicitly skip diagnostics. This is syntax checking, not typechecking, lint, runtime verification or an LSP replacement. |
| Wasteful verification and missed background results | Only explicitly declared independent baseline check groups overlap, at most two at once; all started checks settle before failure. Background outcomes update existing cards at model safe points. A final completion gate keeps durable turns active until pending work settles and newly observed results receive another model step. | Local command and mocked lifecycle tests verify paging, status, card identity, bounded parallelism and publication gating. Legacy non-step execution fails closed at this boundary instead of claiming completion. Safe-point observations are not unsolicited idle-agent wakeups. |
| No per-tool/model feedback | SDK execution/model hooks emit bounded durations, first-output latency, failure classes, repeated-read signals, active schemas and cache usage. | Tests exercise actual SDK hooks and strict analytics field filtering. No arguments, raw output, paths or reasoning are sent through these metrics. SDK telemetry input/output recording is explicitly disabled. Transport failures without SDK completion hooks may only have existing turn-level failure events. |

## Reuse and scope

- AI SDK 7.0.118 and OpenAI adapter 4.0.78 already existed; their tool search, provider tool and timing hooks are reused.
- `@openai/agents-core` 0.19.0 (MIT): only the pure `/utils` V4A parser is imported; its agent runtime/default trace processor is not used.
- `yaml` 2.9.0 parses bounded skill frontmatter with aliases disabled.
- TypeScript 6.0.3 is a production dependency because syntax diagnostics execute in the Node executor, not only in development.
- No database migration, paid inference, VM creation or deployment is required by this implementation batch.

## What still requires proof

Run one meaningful paired batch after implementation verification—not a benchmark after every small edit. Keep model, reasoning, fast mode, checkout, machine resources, acceptance tests and prompt comparable. Record wall time, total inference/VM cost, interventions, full-check results and independently reviewed code quality. A passing fixture suite cannot establish “at least as good as Codex,” let alone world-leading quality. The last pre-batch comparison was slower; do not overwrite that evidence with feature-completeness claims.

Remaining empirical questions include native subscription backend acceptance of the patch wire format, discovery accuracy/latency on real providers, developer-visible first-output latency, and net performance of parallel verification on realistic repositories. Search is complete bounded Git text search, not Cursor's proprietary indexed search or semantic retrieval. Source evidence is conservative revision invalidation, not a semantic knowledge graph. Browser/LSP workflows and permanent large-output archives were not replaced by these mechanisms.

## Local verification record

- Full suite: 261 test files passed; 1,298 tests passed, three platform-dependent tests skipped. No paid models or VMs were used.
- Final publication-boundary addition: commands must be fenced successfully before commit, including commands whose acknowledgements were lost. Its dedicated lifecycle regression is run separately after the full-suite checkpoint; the new total is not presented as another full-suite run.
- TypeScript application and Cloudflare Workflow typechecks, Biome lint, production client/server build and `git diff --check` passed for the implementation batch.
- Real local Git/filesystem and macOS tmux verification is distinct from mock-provider/model execution and from live cloud verification. No deployment, commit, push or live comparative benchmark was performed in this implementation turn.
- The self-documenting-code guidance kept provider wire details in adapters, freshness/verification policies in domain modules, and runtime artifacts/discovery/diagnostics in focused services. Dependencies were reused rather than creating a new patch parser, YAML parser or tool-search engine.

## Follow-on implementation and disposable verification

This is a separate batch from the no-migration/no-cloud-resource work above.

- Added bounded language-server definitions, references, hover, diagnostics and read-only rename previews using maintained LSP libraries. The disposable guest proof passed references, rename without edits and native patch application in 7.9 seconds. That is guest-tool verification, not a live model-driven coding benchmark. Servers start per query; this is not a persistent semantic index.
- Added structured Playwright/CDP browser inspections with explicit assertions, bounded console/network evidence and URL redaction. Local Chrome proofs passed; guest-browser end-to-end proof is still separate.
- Added an advisory critical-path parallel work planner, structured source-verified project context packets, transport-specific model profiles, and argument-fingerprinted tool recovery. The planner does not create durable ownership reservations or enforce a persistent DAG scheduler.
- Added development PR-repair receipts, bounded attempt controls and signed Cloudflare Workflow delivery to the existing Node executor. The additive migration was applied to the linked development database. Checks: read was accepted and live-verified for the development repository installation. The shared GitHub App webhook was not replaced.
- Added an evidence-based regression gate requiring comparable paired runs, independent code review and reconciled cost. Missing evidence is inconclusive, not a passing result. This gate is not yet an automated paired evaluation service.
- Full local suite after these additions: 273 files passed, 1,335 tests passed, 3 skipped. Application/Workflow typechecks, lint and the production build passed; final small proof-script changes are checked separately.
- Disposable remote Node/database signing preflight and final Cloudflare Workflow delivery proof passed: unsigned HTTP 401, signed HTTP 202, completed Workflow, exactly one stored receipt after duplicate delivery, and no inference turn. Initial proof packaging failures were corrected without changing production module loading. Live attempts exposed two bugs missed by Node-only fixtures: current Freestyle IDs include a `vm-` prefix, and Cloudflare fetch does not implement `redirect: "error"`. Validation now accepts supported normalized IDs and rejects other origins; manual redirect handling still rejects all non-success statuses. First-deployment Workflow propagation settles before the disposable proof starts. The VM, Workflow, endpoint and isolated database fixtures were deleted afterward; final Freestyle inventory showed zero VMs and zero TLS rules.

The user explicitly chose disposable tests only, superseding approval to restore an always-on worker. No persistent worker or continuous PR-repair webhook is enabled. Paid model inference has not been used in this follow-on batch; disposable VM usage is nonzero and not yet invoice-reconciled. Tool fixtures and transport proofs do not establish native-model wire acceptance, a real CI/review repair completion, benchmark parity, or faster coding than Codex. Those remain verification work, not established claims.

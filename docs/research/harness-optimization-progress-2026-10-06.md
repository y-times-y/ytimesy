# Harness optimization progress — 2026-10-06

## Objective and acceptance

Improve elapsed time, token/compute efficiency and code quality against native Codex on comparable coding tasks. All required instructions, tests, original-contract edge cases, isolation, review and recovery protections remain acceptance constraints. Do not call shorter prompts, passing unit tests or one favorable task a competitive win.

This continues the [source audit](harness-efficiency-audit-2026-10-06.md). Existing uncommitted work was preserved; the working tree also includes changes from earlier turns. No commit, push, migration, deployment or paid run was performed for this batch.

## Implemented first batch

| Parameter | Change | Evidence and limits |
| --- | --- | --- |
| Static instructions | Separate compact cloud lead policy; remove repeated advice and task-specific JavaScript/testing tips from unconditional model guidance. Preserve original requirements, complete reading, read-only leadership, child isolation, review hashes and verification ownership. | Lead role/profile: 18,980 → 6,998 characters (63.1% smaller). Builder: 9,367 → 4,219 (55.0% smaller). Character reductions are not measured token, latency or quality improvements. Native legacy policy remains unchanged. |
| Model/tool alignment | Anthropic receives exact `replace_text` immediately rather than a discovery round trip; other unused single-edit aliases remain deferred. Fix instruction/schema mismatch (`oldText` versus `old`/`new`). | Discovery regressions confirm permissions and other tool surfaces are unchanged. This is family-specific alignment, not completed empirical model/version calibration. |
| Context budget | Budget only model-visible schemas, including tool search. Recalculate after discovery and delegation rather than reserving every deferred schema on every step. | Mocked inference proves a large deferred capability no longer prevents a small request; discovered capabilities still trigger the hard context guard. No hard provider limit was increased. |
| Provider context handling | Enable recoverable consumed-guidance retirement on direct/OpenRouter OpenAI paths, not unverified compatible routes. Add a shared guard against mechanical rewriting of prefix-bound observations. | Regression proves bound-prefix history remains intact even if retirement is mistakenly enabled. Other providers retain their original state; universal compaction parity is not claimed. |
| Early feedback | Return LSP diagnostics when a matching notification arrives, instead of always sleeping 2.5 seconds; retain the bounded wait when no response arrives and reject mismatched document versions. | Real TypeScript-server fixture returns type error 2322 and preserves read-only navigation/rename behavior. LSP processes still start per query; selective persistent sessions remain unfinished. |
| Verification execution | Default checks to ordered execution. Explicit `parallel:true` or patch `parallelChecks:true` enables bounded overlap only for verified independent checks. Preflight remains ordered. Preserve retained results and idempotency. | Regression covers both default sequential and explicit bounded parallel execution, failure/timeout receipts and replay. This prevents implicit unsafe overlap; it is not yet a baseline-authoritative completion gate. |

## Verification

- Prompt/tool/context/command regressions and the real language-server fixture were exercised.
- Typecheck (including workflow types), repository lint and production build passed. Build retains its existing large-chunk warning.
- The initial full-suite run had 1,453 passes, five platform skips and two failures: the new parsed `parallelChecks:false` default required updating an exact fixture expectation; the existing background output-limit test intermittently observed an interrupted tmux command. After the expectation correction, both affected suites passed in isolation (44 tests). The second complete suite passed **279 files / 1,455 tests**, with five platform skips, in 62.60 seconds. The intermittent background failure remains recorded; this batch does not claim to fix its cause.
- The new code has not been live deployed or used in a fresh model-driven benchmark.

## Remaining work, not completed claims

1. Shared/dependency-validated discovery and narrower evidence invalidation; do not make dirty-tree evidence falsely authoritative.
2. Critical-path scheduling and measured handoff/preparation overhead, retaining independent writer VMs.
3. Selective warm LSP sessions and broader actionable edit feedback without turning syntax observations into full typecheck proof.
4. Profile and reduce patch preparation/RPC overhead while preserving guarded edits and uncertain-side-effect handling.
5. General recoverable old-output retirement and safe background compaction, with provider-specific reasoning/prefix constraints.
6. Baseline-authoritative required-check contracts and source-bound final verification receipts.
7. Per-model/version calibration using real errors, cache usage and representative tasks.
8. Live recovery/repair verification and a representative controlled performance evaluation.

Fresh live tests require spending authorization. The requested cap is $20 total disposable Freestyle resources using the existing Codex subscription; no persistent worker is authorized. The existing evaluation bridge, private verifiers and real resource cleanup should be reused. Old narrower native controls cannot establish an equal-condition average; freeze equal task, settings, environment, cache and verification conditions before a new comparison. Do not train changes against private final holdouts.

## Authorized development comparison

The user subsequently authorized a fresh $20 disposable-resource cap with the existing Codex subscription. The first pair used GPT-6.1-Sol, Medium reasoning, fast mode off, the same clean repository snapshot, and identical task prompts explicitly requiring focused tests, typecheck, lint and build. This is one repeated development task, not a protected holdout or an average-performance claim. Provider cache state could not be reset or equalized. Native CLI request/token guards still differ from the product guard.

| First pair | ytimesy | Native Codex |
| --- | ---: | ---: |
| Execution and patch export | 347.034 s | 228.225 s |
| Frozen protected assertions | 562 passed | 562 passed |
| Input tokens, including cached | 482,318 | 508,265 |
| Cache-read input tokens | 310,528 | 457,216 |
| Uncached input tokens | 171,790 | 51,049 |
| Output tokens | 8,501 | 7,453 |

**Not a combined speed/token/quality win.** Our lead chose one builder; the builder turn took roughly 234 seconds, with lead dispatch and review adding roughly 142 seconds in aggregate (partially overlapping). The source policy favored a bounded same-subsystem change too broadly. An intermediate policy favored concurrent independent deliverables and passed its 15 policy regressions, typecheck, lint and production build, but its live result was worse. The final policy compares the complete critical path without treating folder labels as coupling or independence as a guaranteed speedup.

Source review found a native contract error missed by the original grader: its path validator rejected all percent characters, not just percent-encoded text. A separately recorded five-case original-contract adjacency probe passes our patch and fails native on `/100%`. This supplementary result does not replace or retroactively alter the frozen 562-assertion grade; it is not evidence of a general code-quality advantage.

An attempted revised-policy rerun stopped before inference because the operator deleted the test snapshot's source VM too early. The admission guard correctly refused unverified sizing. A recreated clean template is retained until cleanup; the guard was not bypassed or weakened. Test resources and temporary admission headroom are tracked privately under `.ytimesy/harness-optimization-jA3wFJ`; existing builder VMs and borrowed snapshots are outside cleanup scope.

The first frozen protocol inherited an old `baseline` metadata value from the operator script. Its actual deployed source hashes are recorded in `runtime-sources.json`; the task repository remained pinned at `ffb92b004ab9901b25df6d6850949455b6513b44`. The next protocol records current HEAD plus exact dirty-runtime hashes. Neither protocol represents a clean committed release.

### Second trial and revised candidate

The three-builder trial passed the frozen 562 assertions but took **512.820 seconds** through execution/export and used **62 requests / 1,838,278 observed input-plus-output tokens**. Concurrent implementation occurred on separate VMs, with early-completion reviews and server-side integration. Added review and integration outweighed saved generation. The lead also requested a rewrite for an unproven regex concern; both the child and operator reproduced rejection of all five trailing-line-terminator cases in the original JavaScript regex. The final policy now requires a concrete violation or reproduced failure before requesting repair; uncertainty calls for a bounded diagnostic, not simultaneous speculative rewriting.

Executed verification differed in the first pair despite identical prompts: native ran focused tests, while our builder also ran `pnpm test`. These are diagnostic timings, not an equal-verification speed verdict. A new pair explicitly requires the entire unfiltered suite in both prompts, in addition to focused tests, typecheck, lint and build.

Fresh unbound OpenAI histories can now place complete authorized preflight reads before the variable user prompt, using stable call IDs. Other providers and bound-prefix histories retain their order. This removes one structural impediment to cacheable prefixes but does not guarantee cross-chat cache hits; account/chat cache affinity remains unchanged. Codex prefetch was disabled in the earlier trials, so random prefetch IDs did **not** cause their observed overhead. It is enabled in the new candidate and has reached live subscription inference successfully; token/latency benefit remains under measurement.

Local verification: 49 targeted regressions passed, typecheck and lint passed, production build passed with the existing chunk warning. A default-concurrency full-suite run had one five-second PGlite migration timeout; the unchanged test passed alone, then the unfiltered suite with two workers passed **279 files / 1,456 tests**, five platform skips, in 61.49 seconds. This does not claim to fix the timeout's cause.

### Equal-check attempt and environment correction

The third trial explicitly required focused tests, the full unfiltered suite,
typecheck, lint and build from both arms. Our reviewed result passed all 562
protected assertions in **431.684 seconds** through execution/export, with
**21 requests / 648,774 observed input-plus-output tokens**. Its input included
386,560 cache-read tokens and 250,721 uncached tokens; output was 11,493 tokens.
The source checkout's unfiltered suite passed 1,037 tests. This older task
checkout is distinct from the current runtime checkout's local test count.

Native did not complete before its 600-second inference deadline. Its repeated
unfiltered attempts stalled after daemon/process tests failed. A subsequent
zero-inference diagnostic on the retained disposable template reproduced the
cause: the same four daemon-reader tests pass directly, but fail with
`spawnSync python3 EPERM` inside Codex's nested `workspace-write` Linux sandbox.
**That timeout is not a competitive win.** The control environment, not the task
or grader, is being corrected: subsequent native controls use the isolated
disposable VM as their execution boundary, matching product guest shell
execution, rather than imposing a second OS sandbox only on native. They still
receive no refresh token or application authority, retain deadlines and exact
scope grading, and report `executionIsolation: disposable-vm`. The original
failed result remains unchanged. Model request/token guard and cache-state
differences still prevent a final equivalent-budget claim.

The third trial also exposed an unnecessary child wake-up just to resend
verification references missing from the task-list preview. `read_task_summary`
now retrieves Unicode-safe, bounded pages of the descendant's latest recorded
message through the existing owner/project/task-tree authorization, with no
VM preparation or inference. This text remains agent-reported, not success
proof; actual completion receipts still require `read_task_output`. Regression
tests cover pagination, invalid cursors, foreign/unrelated targets and the
absence of model dispatch. It is immediately discoverable to leads, deferred
for builders, and available to the read-only competition judge.

After this fix, the unfiltered local suite passed **279 files / 1,458 tests**,
with five platform skips, in 62.33 seconds. Typecheck, lint and production build
passed; the native control fixture also passed after the isolation change.
The new summary-read latency benefit is not established by these local tests.

### Corrected full-check comparison

The fourth pair used the corrected disposable-VM execution boundary. Both
arms completed the required focused tests, full unfiltered suite, typecheck,
lint and build, and passed all 562 frozen assertions.

| Fourth pair | ytimesy | Native Codex |
| --- | ---: | ---: |
| Execution and patch export | 416.290 s | 304.880 s |
| Input tokens, including cached | 647,843 | 539,626 |
| Cache-read input tokens | 418,176 | 499,456 |
| Uncached input tokens | 229,667 | 40,170 |
| Output tokens | 10,697 | 7,769 |

Our result was 36.5% slower, with approximately 5.7 times as many uncached
input tokens. Both patches also passed the supplementary five-case path
probe: the first native patch's contract error is not a current quality
advantage. The lead used one builder and did not wake a finished builder to
retrieve its summary; the new summary tool was not called, so this run cannot
attribute a speed improvement to that tool.

The next candidate retains consumed guidance while the working context has
room, retiring it recoverably only when the configured compaction threshold
is reached. Previously, early retirement could rewrite an otherwise cacheable
prefix before context pressure required it. Bound-prefix providers retain
their existing behavior; no cache/session identity is shared between users or
chats, and compaction limits are not raised. Local archive/context regressions
passed, followed by 279 files / 1,459 tests and five platform skips, typecheck,
lint and build. An additional ownership regression subsequently passed in
the eight-test task-evidence suite. Its live latency and token benefit remains
under measurement in an ours-only fifth trial against the recorded fourth
native control; this is not an independent paired sample or a final holdout.

The strictly read-only lead still adds dispatch and review work to bounded
changes. Allowing direct implementation for small tasks would change an
explicit product rule and requires the user's architectural choice; it has
not been silently enabled to improve this benchmark.

### Fifth trial and disposable cleanup

The fifth ours-only run completed in **376.422 seconds** through execution and
patch export (378.463 seconds including grading), with all 562 protected
assertions passing. Its focused 87 tests, unfiltered 1,018-test suite,
typecheck, lint and build all completed with exit 0. Initial test-table and
lint errors were repaired before final verification; those failed attempts
remain in the evidence rather than being erased. The supplementary path
probe is separate from the original frozen grader. **It failed this patch on
the original-contract valid path `/100%`: validation rejected literal percent
text rather than only encoded text.** Passing the 562 assertions therefore
does not establish complete contract correctness for this result. The earlier
fourth pair passed this supplementary check in both arms.

| Same development task | Fourth ours | Fifth ours | Recorded corrected native |
| --- | ---: | ---: | ---: |
| Execution and patch export | 416.290 s | 376.422 s | 304.880 s |
| Input including cached | 647,843 | 794,299 | 539,626 |
| Cached input | 418,176 | 517,248 | 499,456 |
| Uncached input | 229,667 | 277,051 | 40,170 |
| Output | 10,697 | 8,957 | 7,769 |
| Observed input plus output | 658,540 | 803,256 | 547,395 |

This is approximately 9.6% faster than the fourth ours run, but 23.5% slower
than the recorded native control, with greater total and uncached token use.
**There is no combined speed/token/code-quality win.** A single stochastic
run does not establish causation for the cache-preservation candidate. Its
source behavior is tested, but measured cache efficiency did not improve in
this trial. Neither private final holdouts nor a representative paired task
average were run.

The fifth trial's overrestriction also survived the existing review checklist.
The subsequent general policy requires retained executable valid-neighbor and
forbidden-case evidence derived from the original contract, assigned before
launch and included in the first handoff. Both roles receive the same rule;
no benchmark-specific examples or hidden verifier answers enter the prompt.
This is a prompt-level safeguard, not a deterministic semantic verifier, and
its live effectiveness has not been established. No sixth live run occurred.

Local verification before the final review-policy addition: **279 files /
1,460 tests passed**, five platform skips. After that addition, all 16
orchestration regressions, typecheck, lint and production build passed;
`git diff --check` passed. The final ownership guard and review-policy
addition were not part of the fifth deployed runtime hash.

Disposable cleanup completed at 17:56 UTC: the owned evaluation worker,
template VM and snapshot were deleted, and each arm's resources had already
been removed by the evaluator. Provider inventory returned to the exact four
pre-existing VMs and four pre-existing snapshots, including the borrowed
snapshot. Temporary admission headroom was withdrawn. No persistent worker,
production deployment, paid API fallback, Cursor merge, commit or push was
performed. Provider invoice reconciliation remains separate from these
resource-inventory checks; no exact dollar charge is claimed.

### Read-only lead efficiency and check evidence batch

This subsequent local batch keeps the lead read-only and mandatory builder
delegation intact. It reuses the existing guidance, output-artifact and source
evidence services rather than adding another orchestration or storage layer.

- Complete unchanged instructions already present in the current model context
  are returned as hash references. New, changed or incompletely read instructions
  still return their bodies; nested guidance discovery and linked-document reads
  remain intact. A new builder does not inherit the lead's consumed-guidance state.
- Lead preflight reads guidance and capacity, without eagerly repeating the
  builder's environment report. Environment inspection remains available on demand.
- `run_checks` supports compact retained-output summaries and bounded declared
  source paths. Full logs remain retrievable. Check receipts record actual status,
  stop reason and before/after source hashes; changed or unhashable declared
  sources prevent a supplied receipt from establishing success.
- Lead evidence reads recompute source freshness. An automatic publication commit
  preserving the checked bytes remains valid; subsequent file edits invalidate it.
  Supplied `verificationReferences` must pass this check before writable-task
  acceptance. Legacy/manual acceptance without references remains supported and
  must not be presented as verified-check proof.
- Both roles receive original-contract boundary-review guidance: executable
  allowed-neighbor and forbidden-case checks, retained evidence, and independent
  inspection rather than treating generated tests as the contract. This is not a
  deterministic semantic verifier.
- Numeric prepared-prompt and tool-definition character counts augment existing
  token/cache/timing metrics. Content is not captured by these metrics, and
  character counts are not provider-billed token measurements.

Source binding covers only the declared files, not every environment dependency
or the complete repository automatically. Guest-retained receipts are not a
tamper-proof protected grader. Summary tails can omit important details: failure
or uncertainty requires full-output retrieval. No required check is removed.

The batch has no new database schema, production deployment or live inference.
Its competitive latency/token benefit is unmeasured. The next evaluation should
freeze this runtime and test bounded coupled edits, substantial disjoint work and
bug fixes under identical model/reasoning/cache/environment conditions. Report
time, uncached input and output tokens, contract correctness, reviewable code
quality and human interventions separately; do not infer superiority from one
development task or tune against protected answers.

Local verification for this batch: **279 test files / 1,469 tests passed**, five
platform skips, followed by successful typecheck (including Workflows), lint,
production build and `git diff --check`. The publication-commit/source-edit
regression exercises real local Git and output retention, not a live cloud model.
No commit or push was performed in this batch.

### Sixth live trial: measured effect of the efficiency/evidence batch

An ours-only production-harness run completed on 2026-10-06, using the same
development task, baseline, GPT-6.1 Sol, Medium reasoning and fast mode off.
The task-prompt SHA-256 remained
`3519e3c579eba63777f813f452bf7383d58eb23a8ba37e5c59b0dc6d23907e7c`;
the protected verifier SHA-256 remained
`28f9b2e4b9a2b1c18e6ee68d6bf3ebb067587b699c8d5763dcf5490b538acb3c`.
Updated runtime files were hash-checked against the disposable worker before
submission. No rescue prompts or changes to the running harness were supplied.

| Measure | Fifth ours | Sixth ours | Recorded corrected native |
| --- | ---: | ---: | ---: |
| Execution and patch export | 376.422 s | 379.963 s | 304.880 s |
| Input including cached | 794,299 | 709,731 | 539,626 |
| Cached input | 517,248 | 547,840 | 499,456 |
| Uncached input | 277,051 | 161,891 | 40,170 |
| Output | 8,957 | 9,124 | 7,769 |
| Observed input plus output | 803,256 | 718,855 | 547,395 |
| Protected assertions | 562 pass | 562 pass | 562 pass |
| Supplementary original-contract path probe | Fail | 5 pass | 5 pass |

Versus the fifth run, uncached input decreased **41.6%**, total observed tokens
decreased **10.5%**, and output increased **1.9%**. Time increased **0.94%**.
This is a token/correctness improvement in this sample, not a speed win or a
causal estimate isolated from model/cache variability. Our time remains 24.6%
higher than the recorded native execution time, and our uncached input remains
4.03 times its value. No representative paired average or final holdout ran.

The lead again selected one isolated builder, explaining that six small pure
validator files did not justify integration overhead. Dispatch took about
49.7 seconds versus 41.2 seconds in the fifth trial. It still made discretionary
environment/capacity reads. Scoped guidance responses fell from 10,597 to
8,803 characters in each role. The lead still made nine output reads, now
bounded summaries: six check stdout streams and three warning stderr streams.
All six declared source paths were stable and current. Acceptance supplied
all six retained check references and passed the actual evidence gate.

The builder ran 106 focused tests and the entire unfiltered suite (202 files,
1,037 tests), typecheck, lint and production build, all exit 0 with no stop.
It also ran an extra warning-strict Biome check. An earlier formatting failure
was repaired without suppression; successful final checks do not erase it.
The exported patch changes only the six allowed files, uses no new dependencies,
and preserves literal percent paths while rejecting encoded sequences. Manual
inspection and passing protected checks do not establish universal code quality.

Remaining measurable overhead includes lead dispatch, one-builder sequential
execution, review inference, nine receipt reads and repeated source-binding
metadata within a batched check response. Summary mode reduces log volume but
does not eliminate those operations. The result does not justify skipping checks
or forcing extra builders onto every bounded task.

Raw redacted artifacts are retained privately under
`.ytimesy/harness-new-batch-YUcz7L/83f9465c-d194-4659-b60d-3a63c6a8bb60/`.
The evaluator removed the disposable task tree; at 18:47:00 UTC, cleanup deleted
the owned worker, template VM and snapshot and withdrew temporary admission
headroom. Provider inventory returned to the exact four pre-existing VMs and
four snapshots. No existing machine was changed. No persistent deployment,
paid API fallback, commit or push occurred. Token counts are not an invoice;
provider charges/free allowances require separate reconciliation.

## Review-bundle and check-scheduling batch

Implemented after the sixth trace exposed repeated review observations:

- `read_task_checks` fetches both retained streams for up to eight foreground
  checks in one guest call. It returns one shared before/after/current source
  proof per distinct binding, indexed by each command. Actual completion,
  stderr, omission counts and full-log recovery pointers remain available.
  Owner/project and descendant authorization are unchanged; missing or stale
  evidence is not a pass. Hash-bound acceptance uses the same bundle and gates
  every supplied reference. Guest receipts are not tamper-proof grading.
- `run_checks.groups` explicitly partitions every command exactly once into
  ordered groups. Each group has at most two concurrent commands; the next
  group waits. Duplicate, omitted, out-of-range indices or contradictory
  parallel flags are rejected before execution. Independence remains an
  explicit caller responsibility, not an inference from command names.
- Patch-time verification now carries source paths, summary output and groups.
  Existing project-configured formatting and lint preflight run before final
  checks; invalid group plans are rejected before edits. No custom linter or
  automatic omission of required verification was introduced.
- Role guidance reuses current prefetched capacity, restricts handoffs to
  relevant source-linked findings rather than transcripts, and recognizes
  meaningful independent boundary-test work. It keeps the lead read-only,
  avoids forced splitting of trivial edits and preserves full verification.

Local verification: 280 test files / 1,472 passing tests / five platform skips;
typecheck including Workflows, lint, build and diff check passed. A subsequent
targeted rerun covering ordered overlap, receipt bundling and prompts passed
36 tests with two platform skips. Real filesystem tests confirm one log read
plus one shared fresh source observation for two checks, stderr/failure
preservation and rejection after source changes. These facts establish local
behavior, not an end-to-end speed advantage.

The same-task live trial uses `.ytimesy/harness-review-bundle-n05wvZ/`, the
unchanged baseline, prompt and protected verifier, GPT-6.1 Sol / Medium / fast
off, and the existing Codex subscription. No native rerun, production change,
paid API fallback or rescue prompt is authorized by this batch. Results and
cleanup will be recorded below after completion.

### Seventh trial: failure, not a performance win

Retained run: `69e6069f-4624-48da-aa75-fe0abac07540`. Two test-setup guard
checks stopped before inference (remote guard, then local evaluator guard);
the actual frozen attempt began only after both were enabled. Runtime sources
were checked against the disposable worker. There were no rescue prompts or
runtime changes during that attempt.

The leader launched three isolated writers together after roughly 57.4 seconds.
All three used patch-time verification. It reviewed early finishers and used
`read_task_checks` for three child check bundles and the later integration
bundle. Those are observed behavioral improvements, not end-to-end wins.

Integration initially ran passing lint, typecheck, full suite (202 files /
1,137 tests) and build. However, the existing helper appended test/build logging
flags and did not source-bind its receipts. The leader requested an additional
integration turn for exact commands and source-bound evidence. That child
completed 206 focused tests, the exact full suite and required lint/typecheck/
build checks with exit 0 and no stop, and retained all six declared source
bindings. This duplicate final verification increased time and inference.

The root then failed with the persisted error: "Turn heartbeat or coordination
service became unavailable." A separate read-only observer also encountered
a PostgreSQL connection timeout. The retained evidence does not establish
which heartbeat stage failed; do not assert a Cloudflare or database root cause
without the worker's stage log. The fail-closed ownership protection remains
unchanged.

The evaluator recorded **742.329 seconds elapsed** and a harness-failure grade:
"Production tree has not completed successfully." Its observation counter was
**1,596,523 input-plus-output tokens over 42 requests**. This is an unsuccessful
attempt, not a completed-task time, a protected-grader pass, or a trustworthy
new uncached-token total (the failed final turn did not preserve complete
per-message usage). It cannot demonstrate beating the previous 379.963-second
successful ytimesy run or the recorded 304.880-second native result.

Cleanup at 19:17:27 UTC deleted this attempt's worker/template/snapshot,
withdrew the temporary admission grant, and returned provider inventory to
the four pre-existing VMs and four snapshots. Existing machines were untouched.

### Post-trial integration fix, locally verified only

- Baseline integration now runs configured scripts unchanged, without invented
  logging flags. Full output already has retained paging; suppressing logs is
  unnecessary.
- Optional `additionalChecks` adds contract-specific checks to integration
  without replacing baseline checks, avoiding a verification-only inference
  turn for an already known requirement.
- Optional `sourcePaths` retains immutable before/after bindings for every
  integration check. Every declared path must remain stable; changes retain
  evidence but mark integration failed. The existing eight-file declaration
  limit is explicit; it is not whole-repository or semantic proof.
- Tests cover retaining every baseline check alongside deduplicated additional
  checks, shared source binding and stale-source failure before commit/success.

No subsequent paid/live attempt has verified these post-trial changes. The
overall performance objective remains unachieved; the failed trial is retained,
not removed or reclassified as success.

Final local verification after the integration fix: **280 test files / 1,474
passing tests / five platform skips**. Typecheck including Workflows, lint,
production build and `git diff --check` passed. No production deployment,
commit, push or persistent compute was left by this batch.

### Eighth and ninth trials: retain failures and recovery separately

The eighth attempt (`a08a977d-3200-4abd-92c3-e3b44c56c4eb`) stopped after
38.160 seconds, three requests and 55,743 observed tokens, before launching a
child. The provider stream failed after HTTP 200; this was not a successful
coding result. Failure messages now distinguish accepted-but-failed streams
from rejected requests. Diagnostic logging allows only predefined categories,
HTTP status and whitelisted provider codes; no credentials or raw payloads.

The ninth attempt (`52678510-86f8-4dfe-bad3-5d704072f2f4`) completed three
isolated builders and server-side combined integration, with exact source-bound
review acceptance. Its local observer was interrupted and then lost database
DNS connectivity. The recorded 7,012.252-second infrastructure failure must not
be used as agent execution time. Recovered durable turn timestamps span
20:19:48.094–20:27:01.165 UTC (433.071 seconds); this excludes normal patch
export and grading, so it is not a comparable end-to-end result.

The recovered exact reviewed patch independently passed all **562 protected
configuration assertions**. The durable guard counted **42 requests and
1,619,687 observed tokens**, approximately 2.96 times the native control's
547,395. This is not a speed or token-efficiency win. Separate launches occurred
38.9, 55.7 and 72.7 seconds after root submission. Builder initialization and
independent review calls still incurred sequential inference round trips.

The new heartbeat regression verifies coordination renewal continues while a
database renewal is delayed. Fenced database renewal retries once after 250ms
only for selected connection-loss errors; a rejected fence, authentication
failure or exhausted retry still aborts. Commands and provider streams are not
replayed. No heartbeat failure occurred in the recovered ninth trial; one
successful trial is not proof against all service outages.

Local full-suite checking exposed a cold language-server race: waiting only
2.5 seconds could return diagnosticsObserved:false before a real TypeScript
server loaded its project. The wait now ends on its notification, with a
15-second bound inside the existing 40-second watchdog; missing diagnostics
remain explicit. A regression delays real server startup by three seconds and
requires the actual type-error diagnostic rather than treating no output as
success. Targeted tests, typecheck, lint and build passed. A fresh full-suite
run remains required; the interrupted earlier run is not a clean-suite pass.

The next frozen trial explicitly permits independent Codex tool calls in one
response, instructs batched independent launches/reviews without batching
evidence-dependent decisions, and prefetches actual builder working-tree state
with the existing authorized read tool. This does not weaken required reading,
isolation, original-contract review, protected assertions or source fencing.
No performance improvement is claimed before its measured result.

The ninth batch's sessions, template, disposable worker and owned snapshot were
removed; its temporary grant was withdrawn. Four pre-existing VMs remain.
An additional snapshot appeared in inventory whose ownership was not established;
it was preserved rather than deleting another actor's resource.

### Tenth trial and resumed batching work

Trial `ac4b04b3-90db-4d4c-8dcc-09c99855f9c0` completed in **379.005 seconds**
including export/grading (376.975 seconds execution/export). Three isolated
builders and deterministic reviewed integration passed **562 protected** and
**five supplementary original-contract assertions**. The durable guard recorded
**1,656,705 observed input-plus-output tokens and 44 requests**. Native control
remains 307.199 seconds end-to-end and 547,395 observed tokens. This is not a win;
tokens increased despite a successful quality grade and no heartbeat failure.

The provider permits parallel tool calls, but the lead still generated separate
launch calls and independent review reads. Prompt permission alone did not remove
those inference steps. Resumed implementation adds two bounded cloud tools:

- `launch_ready_tasks` validates disjoint declared ownership and current capacity,
  then concurrently calls the existing per-child create/start executor. Every
  child retains its own request fingerprint and receipt; partial starts return
  retained draft IDs or an explicit uncertain outcome, never automatic replay.
  Declared ownership is passed to each standalone prompt, not represented as an
  OS-enforced write sandbox.
- `batch_read` calls only a fixed allowlist of existing authorized read tools,
  retaining their original bounded output, source hashes and continuation cursors.
  Synchronous or asynchronous read failure does not fabricate evidence or prevent
  independent reads from settling. It cannot run commands, mutate files, launch,
  accept or publish. Repository guidance stays on its individual complete-read
  and recoverable-archive path.

Targeted batching tests pass. These mechanisms remain performance hypotheses
until another unchanged-task, unchanged-model frozen trial. They do not replace
complete source review, required verification or protected grading. Tenth-trial
test resources were removed and its exact temporary grant withdrawn; existing
user machines and the unidentified snapshot were preserved. No commit, push,
production rollout or persistent worker was performed.

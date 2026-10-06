# Subscription harness rerun: compatibility fixed, performance not won

October 5, 2026. This is a repeated development diagnostic on one known task,
not a protected holdout or evidence of general superiority.

## Conditions

Only ytimesy ran inference in this rerun. The comparator is the recorded native
Codex result in [the paired transport diagnostic](VERIFICATION-2026-10-05-PATCH-TRANSPORT.md).
The prompt, GPT-6.1 Sol model, Medium reasoning, Fast mode off, clean source
`ffb92b004ab9901b25df6d6850949455b6513b44`, and protected verifier were unchanged.
The verifier's SHA-256 remained
`28f9b2e4b9a2b1c18e6ee68d6bf3ebb067587b699c8d5763dcf5490b538acb3c`.
No rescue prompts or runtime changes occurred during either rerun.

The dirty development runtime was hash-checked against the disposable worker.
Writers used the existing function-based V4A editor, not the subscription
backend's unsupported public API `apply_patch` tool. A separate live preflight
executed that real editor and independently checked the exact resulting file.
Publication was disabled; the evaluation output was not merged into the app.

## Recorded outcomes

| Execution | Outcome | Time | Input | Cached input | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| Recorded native control | 562 protected assertions passed | 214,951 ms | 391,475 | 348,416 | 7,407 |
| First ytimesy rerun | Incomplete: VM admission exhausted | 232,022 ms | Not used for efficiency comparison | — | — |
| Second ytimesy rerun | 562 protected assertions passed | 401,025 ms | 1,870,165 | 1,537,024 | 13,470 |
| Batched-read/review-import rerun | 562 protected assertions passed | 388,174 ms | 1,848,860 | 1,522,816 | 13,385 |
| Coalesced progress / early native checkpoint rerun | 562 protected assertions passed | 586,861 ms | 876,219 | 422,528 | 17,087 |
| Ready launch / descendant evidence rerun | Incomplete: final leader request failed after review | 575,064 ms | 1,005,269 | 490,112 | 19,577 |

The batched-read run (`b4dffabb-0366-4a78-ad78-abc7524a5789`) used the same
frozen task and verifier. Total input/output was 1,862,245 tokens, still above
the 398,882-token control. Its execution/export took 386,010 ms and grading
2,164 ms; shared preparation took 4,433 ms separately. Three builders ran on
isolated machines and were reviewed, followed by deterministic integration.
Independent inspection found only the six permitted files, ordered validators,
prototype-safe environment insertion, exact-value preservation and fresh service
objects. The strict-end regex remains less readable than a named syntax helper.
The improvement does not establish superiority. Its worker, template and snapshot
were removed, the temporary allowance withdrawn, and provider inventory verified
empty. Private raw evidence is in `.ytimesy/harness-efficient-Y8YIjo/`.

The early-checkpoint run (`9a8dca81-eb12-4a29-bb37-3d3a6467eb9c`) used one
builder, coalesced progress writes and a 32,000-token working-context trigger.
Its total input/output was 893,306 tokens: lower than the preceding run but
still above the control, with worse wall time. Repeated native compaction,
large command-output pagination and a missing descendant-output reader
added turns. The leader's own output reader could not access a child's
session-scoped artifacts. That failure prompted extra evidence requests rather
than independent direct inspection. Correctness passed; performance did not.
Owned test compute and the exact grant were removed. One unrelated VM remained
and was deliberately preserved; this run does not establish an empty account.
Private raw evidence is in `.ytimesy/harness-economy-8ul73B/`.

The ready-launch run (`882f08a5-7405-4012-8bf9-f44636c3124c`) started its
builder 20.848 seconds after the lead instead of 71.545 seconds in the preceding
run. Authorized descendant output inspection worked and the exact writer patch
was marked reviewed. The last leader model request failed with no usable provider
reason; the production tree did not settle successfully, so no protected pass is
claimed. Total input/output was 1,024,846 tokens. Large build-output pagination
and repeated compaction remained expensive. The builder used 4 vCPU / 16 GiB;
resource equivalence to the native control is not established. Owned compute,
template, snapshot and exact allowance grant were removed. Unrelated account
machines and snapshots were preserved. Private evidence is in
`.ytimesy/harness-ready-JTKa3i/`.

The 48,000-token working-context trigger was used in the failed ready-launch
run. It is now removed. New unmeasured changes use provider-reported input/output
usage as the context anchor and conservatively estimate only newly added history,
including unsent function results. This avoids counting opaque wire encoding as
text a second time; it does not discard or rewrite that state. Missing usage
still falls back to conservative estimation, and provider-specific compaction
thresholds and the hard window remain enforced. Scoped Git search/listing now
accept literal repository paths. Fully specified delegation yields instead of
duplicating implementation investigation. Runner-supported concise output keeps
warnings, errors, complete retained evidence and all required checks.

One SDK-managed retry is allowed for retryable request-start failures; streams
are never replayed after visible output. Local tests prove this, single execution
of a tool after retry, preserved rate-limit diagnostics, and non-retry of
unclassified failures. It does not explain the preceding unknown live failure.
A live native-checkpoint preflight
reduced estimated history from 27,274 to 5,702 tokens and retained the independently
checked Freestyle/TanStack/Effect facts. It took 50,682 ms; compaction consumed
19,305 input/output tokens and replay consumed 2,547. This narrow recall probe
does not establish general memory quality or a timing benefit. Its initial replay
probe incorrectly used non-streaming generation, which the subscription backend
rejects; the corrected streaming continuation passed. No production rollout or
native Codex control inference occurred.

Successful rerun: `2a1f18ad-c021-46cc-9618-241250b91207`.
Failed admission rerun: `80a6921a-f00a-496b-a635-809b9a5cc542`.

The successful rerun took **1.87 times** the recorded control's wall time and
used **4.72 times** its total input-plus-output tokens. Cached tokens are a
subset of input, not additional tokens. ytimesy's uncached input was 333,141
versus 43,059 for the control. These are token counts, not dollar-cost ratios:
subscription limits, cache accounting and VM charges are separate. The rerun
recorded 56 request reservations, which need not equal successful generations.

Shared preparation was 8,041 ms, reported separately from the 401,025 ms.
Execution/export took 398,756 ms and protected grading took 2,269 ms.
Different execution/tool sandboxes and the absence of a fresh control limit
causal conclusions. This result does **not** establish a speed, token-efficiency,
or coding-quality win.

## Critical path and correctness

- Initial lead turn: 83.741 seconds. Builders started 58.764 seconds into it.
- Three actual builders ran concurrently on separate VMs: 127.757, 143.646,
  and 147.346 seconds. Every builder completed and received exact-diff review.
- The first completion woke the lead for review while siblings still ran.
- Final lead turn: 189.204 seconds, including fresh isolated deterministic
  integration, baseline checks, combined-diff acceptance and final response.
- Integration did not use an integration-model turn. All imports matched
  reviewed patch hashes, and all recorded checks exited zero.
- Integration ran lint, typecheck, the full clean-base suite (202 files,
  1,134 tests; reported test duration 56.29 seconds), and production build.
- No failed tool calls appeared in the successful run's captured journal.

Independent patch inspection found only the six allowed validator/test files.
Implementations are small typed functions with ordered validation, non-mutating
inputs, fresh service objects and prototype-safe environment insertion. Tests
cover malformed names/paths, duplicate ordering, exact values and non-mutation.
No dependencies, grader access, test bypasses or out-of-scope edits were found.
Passing these checks establishes correctness on this task, not superior code
quality across repositories. The environment validator's strict end-of-string
regex is less immediately readable than a simple character validation; that
is a readability observation, not a failed protected assertion.

Command-level integration timing was not recorded, so the final lead's 189
seconds cannot honestly all be attributed to model reasoning or to tests.

## Admission failure and cleanup

The first rerun failed because historical infrastructure usage and unresolved
reservations consumed the temporary allowance. Two builders ran; the third
could not obtain its VM. Editing-tool compatibility did not fail again.
For the second run, temporary headroom covered that historical deficit plus
exactly $5 available test allowance. Unknown historical reservations were not
refunded or erased. This was operator test setup, not a production accounting fix.

Both disposable runs were cleaned up, their exact temporary grants withdrawn,
and their disposable projects removed. The final provider inventory contained
zero VMs and zero snapshots. No persistent worker was left running. Actual
compute, storage and transfer charges were not independently invoice-reconciled.
Private raw results and patches remain in `.ytimesy/subscription-fixed-ZHzcxy/`
and `.ytimesy/subscription-headroom-Iml1EB/`; they are intentionally not committed.

## Follow-up changes, separate from the measured result

`read_environment_report`, `inspect_task_diff`, `mark_task_reviewed` and
`integrate_reviewed_tasks` are now immediate tools when the role is already
authorized to use them. Previously even these required setup/review operations
needed SDK tool-search discovery. Optional capabilities remain deferred;
discovery cannot grant a missing capability. This removes a required discovery
dependency, but its live timing/token benefit has **not** been measured.

Reviewed import now decodes and applies in one guest command instead of two,
checking the decoded SHA-256 before Git. Cleanup remains separate and runs on
failure. Deterministic integration also reuses its already-resolved workspace
for sibling imports instead of repeating machine/checkout preparation for each
one. Supplied workspace identity must match the destination; source ownership,
fresh acceptance rechecks, Git base checks, OS import locking and durable
receipt recovery remain intact. Tests execute real local Git imports, including
corrupt transfer rejection, conflicts, changed reviews, concurrent identical
imports and lost receipt recovery. These changes have not had a live timed rerun.

Local verification after these follow-ups: 54 transport/discovery/evaluation
tests and 48 reviewed-import/integration/recovery tests passed; TypeScript
checking and changed-file Biome checks passed. The mocked native evaluation test
does not launch native inference. No fresh full-suite result is claimed.

Do not rerun the native control or claim a win from this change. Further work
must reduce repeated orientation and the integration critical path without
discarding required instructions, acceptance checks or protected verification.

## Measured-context follow-up (2026-10-06 UTC)

The ytimesy-only run `35346505-4489-4fe8-96cd-5ca7dea31b42` passed
all 562 protected assertions in **350,580 ms**, using **871,624 input** and
**8,406 output** tokens (**880,030 total**, deduplicated by user-message ID).
No premature native compaction occurred. It remains slower and uses more total
tokens than the recorded native control; this is not a winning result.
Disposable template/worker/snapshot resources and the exact temporary grant
were removed; unrelated concurrent-agent resources were preserved.

Subsequent changes add a bounded `apply_patches` batch using the maintained V4A
parser and existing per-file compare-and-swap editing. All diffs are prepared
before writes; partial write failures explicitly identify completed, failed and
unattempted files. This is not a transaction. Completed batch receipts prevent
replay. Subscription prompts now name the actual batch tool instead of claiming
the single-operation `apply_patch` accepts multiple files.
Unfinished command waits defer output with an unchanged cursor, leaving live
reads available and complete logs intact; completion still requires inspection.

Local verification: 275 test files passed; 1,376 tests passed and four skipped
(including Linux-only command tests on macOS). Typecheck, build and diff checks
passed. Live timing for these subsequent changes is pending.

The subsequent batch-tool run `a8e4efd5-398d-455d-a9ab-14961c8fe895`
passed all 562 assertions in **431,589 ms** with **1,308,107 input** and
**9,956 output** tokens (**1,318,063 total**; **1,079,296 cache-read**).
The model used `apply_patches` successfully, but ran a full baseline check chain
as well as full final checks and reviewed large baseline build logs. Baseline
checks passed; new-code scoped lint issues required repairs. Verification also
generated an incidental route-tree change, which was restored and typechecked
before handoff. This is a regression, not a win or a reason to remove checks.
Owned disposable resources and the exact grant were removed; unrelated VMs and
snapshots were preserved. Linux command-tool tests passed on the disposable
worker, including deferred-output/live-read/completion behavior.

Next changes explicitly require stable-tree final verification, prohibit
unnecessary duplicate full baseline runs while preserving policy-required
reproductions, and give subscription native compaction a 64K operating target
based on measured provider usage. This target is not the model's hard window.
Opaque canonical checkpoints remain provider-managed. Fifty-one targeted tests
pass, including native checkpoint replay, operating-budget triggering, and
large-ciphertext/small-actual-context non-compaction. Live impact remains pending.

The stable-verification/64K experiment `76a72554-7f50-4330-9c7a-46846e18416c`
passed all 562 assertions in **452,528 ms**, using **984,341 input** and
**12,461 output** tokens (**996,802 total**, **583,552 cache-read**). It remains
inferior to the recorded control. One database connection failure occurred
before inference; startup was retried without rescue prompts. Owned disposable
resources and the exact grant were removed. The 64K subscription default was
not retained: the trial did not justify its compaction overhead/cache impact.

The next runtime prefetches bounded, one-hop local inline Markdown references
from applicable instruction files in the same guidance call. Documents retain
source hashes, provenance and character continuation offsets; network links,
escaped paths, .git files and symlink targets are excluded. This intentionally
is not an exhaustive Markdown parser. Unreferenced skills remain deferred.
Only complete, matching-hash bodies still in active tool-result history may
suppress a repeated body; compaction or source changes cause fresh loading.
Batch file reads report missing/non-file paths individually while preserving
safe available source; unsafe paths still reject the request. The leader policy
now includes adversarial test generation in parallel-work estimates instead of
classifying independent policy work as trivial solely because functions are pure.

Local checks for this next runtime: **275 files / 1,383 tests passed**, four
skipped; typecheck, production build, changed-file Biome and diff checks passed.
No live performance improvement is claimed until the next unchanged trial ends.

The prefetch/parallel trial `b8edb929-3d5b-4c10-ac65-83df2cc73de2` failed at
the frozen deadline without reaching inference. A stale idle transaction from
the previous disposable worker's deletion held advisory admission lock 81738419.
The actual Supavisor session had zero idle-transaction timeout despite the pool's
startup configuration. No rescue or runtime change was made during the trial.
The lock subsequently cleared without terminating a database backend.

Admission now sets 30-second idle and 20-second statement bounds with SET LOCAL
inside the short transaction, uses a non-blocking advisory lock, and discards
connections whose rollback fails. Live pooled-connection settings verified both
bounds. Nine adapter tests and typecheck/build passed. Disposable cleanup now
signals the exact owned worker and waits for graceful drain before deletion;
cleanup preserved all three unrelated VMs and two unrelated snapshots.
The unconstrained local suite had three timing/process-output failures (1,384
passes). The unchanged full suite with two workers subsequently passed all
275 files / 1,387 tests, four skipped, in 59.56 seconds.

The recovered-admission trial `aca6d1bd-2a52-4ce7-9b2e-9cd64af0dd64` ended
at **605,205 ms** without final root completion: **2,950,561 input** and
**15,977 output** tokens (**2,966,538 total**, **2,289,408 cache-read**).
Three builders actually ran concurrently and completed; each patch was reviewed.
Combined server checks passed, but integration provided clipped output without
retained command references or exit receipts to the model. The lead appropriately
refused unsupported verification, requested evidence, and ultimately reran checks
in an integration model turn. The deadline interrupted final root completion.
This is not a passing or faster result; no native Codex inference was rerun.

Automated checks now reuse the existing session-scoped output artifact capture,
return explicit checkResults (command, reference, actual exit/stopped status and
continuation cursors), persist these receipts alongside command output, and include
them in the integration handoff. Complete retained output is readable through the
existing owner/descendant-scoped read_task_output. No checks were removed or their
exit semantics weakened. Targeted integration tests and typecheck passed; full
regression rerun is pending. Owned resources were gracefully stopped and deleted;
three unrelated VMs and two unrelated snapshots remain untouched.

The next runtime also defers unused coordination schemas on child model turns
through the existing AI SDK discovery mechanism. Permissions remain unchanged;
search and prior durable discovery restore those capabilities when needed. The
guidance packet includes bounded root project configuration with exact hashes,
Unicode cursors and active-transcript-only complete-body deduplication. No .env
files or symlink configuration targets are prefetched. Independent initial reads
and completed-child reviews are batched by policy, not acceptance automation.

Latest full local suite: **275 files / 1,392 passed**, four skipped, 61.09 seconds.
Typecheck, production build and targeted integration/discovery/guidance tests pass.
The next unchanged ytimesy-only run is pending; no performance win is claimed.

Trial `8b7c2613-fe68-4cfd-8d07-f639538e0855` passed all **562 assertions**
in **412,278 ms**, using **1,485,734 input** and **15,416 output** tokens
(**1,501,150 total**, **1,221,376 cache-read**, 42 model requests).
Three builders ran concurrently. Real retained integration receipts were read
by the lead; no second integration model turn or verification rerun was needed.
This proves the evidence-handoff repair, not superiority to the recorded control.
Main-agent source review found readable, bounded, pure implementations and typed
boundary tests, but the services validator rejects every percent sign, not just
percent-encoded text: that potentially over-restrictive interpretation is not
covered by the frozen assertions and must not be silently treated as quality proof.
The recorded final combined-diff UI receipt is clipped; individual source-diff
receipts remain complete. No actual provider history was clipped for this review.
Owned resources were gracefully deleted, preserving unrelated resources.

Next experiment: explicit coordination-cost comparison and complete verification
ownership for a sole coherent builder, plus a 24K operating context target using
native opaque compaction, not a smaller advertised hard context window. Compaction
receives the same discovered/deferred tool surface as inference instead of all
unused schemas. This target is experimental until a live result justifies it.
Latest local suite: **275 files / 1,393 passes**, four skips, 58.49 seconds;
typecheck, build, targeted adapter/policy tests and diff checks passed.

Trial `c6e5f694-378c-42e0-84c1-72c4b91ed1dc` aborted after **211,893 ms**
with `Connection terminated unexpectedly` while observing the live tree. No
protected grade or complete token evidence was captured. This is an infrastructure
failure, not a faster passing result. Native opaque compaction ran on the root,
reducing its reported active context to 7,576 tokens; one coherent builder had
started. All owned disposable resources were gracefully removed.

Read-only evaluation observation now retries narrowly classified transient
connection failures at most twice; submissions, writes and grading mutations
are never replayed. Batch patches now reuse the same guest edit implementation
and lock for all prepared operations in one execution, retaining individual CAS,
mode preservation, diagnostics, partial receipts and unattempted paths. Eight-file
creation uses one edit execution plus exact payload cleanup rather than sixteen
executions. Unknown transport failures remain failures, not guessed receipts.
Generic validator guidance requires the stated contract, not extra restrictions.
Latest suite: **276 files / 1,398 passes**, four skips, 58.81 seconds; typecheck,
production build, scoped Biome and diff checks pass. Next unchanged trial pending.

Trial `45f6332f-de02-4cd2-904b-0475b125c5a8` passed **562 protected assertions**
in **527,703 ms**, using **520,763 input / 18,116 output tokens** (**538,879 total**,
260,736 cache-read). No native control inference ran. One builder completed all
checks; the leader reviewed the exact diff. Independent main-agent source/test
inspection found readable pure validators, explicit first-error precedence,
prototype-safe environment keys, immutable inputs, and tests preserving literal
percent while rejecting encoded text. No other paths changed. This remains slower
and more token-heavy than the recorded control. Owned disposable resources removed.

Next trial removes model polling between independent verification commands using
run_checks, reusing existing session-scoped command cancellation and full artifact
capture with two concurrent checks, ordered actual exits, stop reasons, references
and continuation cursors. Read-only leaders cannot run it. Captured noninteractive
processes disable forced color without filtering diagnostics. Native operating
targets are now role-specific: 48K coordination / 24K implementation, so large
guidance need not delay first child dispatch. Local suite: **276 files / 1,399 passes**,
five platform skips, 57.64 seconds; typecheck and build pass. Linux and live trial pending.

Linux verification subsequently passed all seven command/cancellation tests.
Trial `44833b30-534a-49d1-8d6b-fd0346ff85bb` passed **562 assertions** in
**399,650 ms**, using **373,568 input / 14,531 output tokens** (**388,099 total**,
174,464 cache-read, 17 requests). It is the first current passing trial below the
recorded **398,882-token** control, but still slower than its **214,951 ms** and
slower than our earlier 350,580-ms passing trial. Dispatch improved from roughly
59 to 29 seconds. The live run_checks returned explicit successful receipts for
all focused/full-suite/lint/typecheck/build commands; uncolored logs reduced
repeated output retrieval. Full suite still took 65.32 seconds. A late compaction
and large single-builder generation remained on the critical path. Owned resources
removed; unrelated machines and snapshots preserved.

The next trial explicitly estimates concurrent wall time using the longest
builder path, while summing token/compute cost separately. Distinct contracts with
substantial boundary tests now prefer parallel ownership, not a sole builder merely
because functions are pure. Supported concise runner reporting preserves complete
failures, warnings and test coverage. Review also repaired the edit tool's resolved
.git boundary for parent-directory symlinks, with real-file regression tests.
No frozen task, verifier, source baseline or model/reasoning/fast configuration changed.

Trial `1835431a-56a9-49f4-84a7-3fef04dfa026` failed at **606,806 ms**:
the leader did not complete by the frozen deadline. It used **1,094,292 input /
26,612 output tokens** (**1,120,904 total**, 618,240 cache-read, 56 requests).
Three builders ran concurrently. One encountered an unspecified provider failure
and was autonomously resumed; its exact provider cause is not established.
Combined checks passed, but that is not a completed protected grade or a win.
Repeated leader context replay and late compaction dominated final review.
All owned trial VMs, its snapshot and exact temporary grant were removed;
unrelated machines and snapshots were preserved. No fresh native inference ran.

Trial `16c35e23-5c1e-4c14-81ed-ecef8029a5ea` passed **562 protected assertions**
in **530,908 ms**, using **748,396 input / 26,003 output tokens** (**774,399 total**,
479,232 cache-read, 49 requests). All three parallel builders completed, and
combined verification passed. It is not a speed or token win. Complete independent
source/test inspection found typed pure helpers, correct error precedence,
prototype-safe environment storage, immutable inputs and correct distinction
between literal percent and encoded paths; only the six allowed files changed.
Large success-log pagination and repeated combined review remained costly.
Local suite: **276 files / 1,402 passes / five platform skips**, typecheck and build
passed. Owned trial resources and exact temporary grant removed; unrelated
resources preserved. No fresh native inference ran.

The next candidate prefetches a bounded, non-hidden scoped source inventory in
the existing guidance call (200 paths / 8,000 characters, explicit truncation).
Reuse searches and source inspection remain required; no new index or dependency.
Default verification adds concise reporting only to exact direct `vitest run`
and `vite build` scripts, with correct package-manager forwarding; custom scripts
and explicit recipes remain unchanged. Integration receipts now include bounded
stdout/stderr previews and Unicode-correct continuation offsets, so complete
short output need not be fetched again. All warnings/errors remain retained.
Targeted integration tests: 19 passes. Whole-suite before the preview addition:
276 files / 1,405 passes / five platform skips; typecheck, scoped Biome, diff checks
and the warning-preserving production build pass. New live trial pending.

Trial `9b318aa6-ef4e-46f5-a71d-487a095b2436` passed **562 protected assertions**
in **398,856 ms**, using **642,661 input / 20,648 output tokens** (**663,309 total**,
409,728 cache-read, 42 requests). Relative to the preceding trial: approximately
25% less wall time and 14% fewer tokens; not a win against the recorded control,
nor our fastest or most token-efficient passing trial. Builders avoided list_files
and retained scoped reuse searches/source reads. Complete independent source/test
inspection found typed pure validators, correct precedence and immutable input,
prototype-safe own environment keys, literal-percent support and encoded-path
rejection, with no changes outside the six allowed files. Whole local suite:
276 files / 1,406 passes / five platform skips; typecheck and build pass.
Owned disposable resources and exact grant removed, unrelated resources preserved.

Next candidate removes the advisory planner round trip only for fully specified,
independent, disjoint ready contracts, retaining capacity and repository preflight.
Builders with the batch editor defer unused single-edit aliases; discovered tools
and native provider editors stay available, and permissions do not change.
Native checkpoints are checked against the hard input limit rather than the soft
operating target; regressions prove valid opaque replay above the soft target and
hard-limit rejection without replacing original history. Local checks:
276 files / 1,409 passes / five platform skips, typecheck, scoped Biome, production
build (warnings retained) and diff checks pass. Next unchanged live trial pending.

Trial `e1697c88-ac15-4d4d-a485-9effe80ec9d5` passed all **562 protected assertions**
in **386,427 ms**, using **568,561 input / 19,024 output tokens** (**587,585 total**,
345,984 cache-read, 37 requests). No planner round trip was used. Three parallel
builders still duplicated orientation and required a separate integration checkout.
Independent inspection of the complete six-file patch found readable pure helpers,
correct error precedence, prototype-safe environment keys, exact path validation
and immutable inputs. It is not a win against either recorded control threshold.
The integration VM was 4 vCPU / 16 GiB; equal compute cost is not established.
Owned resources and the exact temporary grant were removed, preserving unrelated
VMs and snapshots. No fresh standalone native Codex control inference ran.

The next candidate groups a bounded batch of small same-subsystem helpers under
one coherent builder when orientation and integration overhead outweigh the saved
parallel work. Substantial independent implementations remain parallel. The sole
builder retains complete final verification ownership. Subscription working-context
target is 48,000 tokens to avoid premature compaction during a bounded batch;
native opaque-state preservation and the hard input limit are unchanged.

Trial `960ffd8e-8dbb-4829-9c46-135e47209d39` passed **562 protected assertions**
in **317,844 ms**, using **576,280 input / 8,433 output tokens** (**584,713 total**,
459,776 cache-read). One coherent builder completed full final checks; no separate
integration checkout was needed. Independent complete-patch inspection confirmed
readable pure validators, exact error precedence, safe own prototype-named keys,
immutable inputs and path semantics; only the six allowed files changed.
Still not a joint win. Owned disposable resources and exact temporary allowance
were cleaned up; unrelated VMs/snapshots remain untouched.

Next candidate archives complete large referenced-document bodies only after a
later assistant observation, using the existing encrypted owner/session-scoped
context archive and recovery tools. Repository instructions, configuration, hashes,
unfinished pages and every opaque reasoning part remain verbatim. Archival failure
prevents projection/inference, and the projected checkpoint is saved before replay.
This is not a textual compaction substitute or reduced mandatory reading.

Trial `51a80a03-1ad7-4575-969b-4a987ce997d4` passed **562 protected assertions**
in **327,145 ms**, using **402,466 input / 10,160 output tokens** (**412,626 total**,
201,344 cache-read). Reduced replay did not yet beat either control threshold.
The builder reread PLAN.md after its prefetched body was archived during preflight.
Complete independent inspection found readable typed pure validators, correct
whole-string and error-precedence behavior, prototype-safe own keys and immutable
inputs; only the six allowed files changed. Owned resources and exact temporary
grant removed; unrelated resources preserved.

The next candidate retains large complete referenced documents through preflight
and the first implementation/delegation decision, then archives only after a later
assistant observation. A regression preserves guidance during read-only source
inspection. Parallelism policy compares substantial independent code/test generation
against actual additional integration/review cost rather than treating all pure
helper batches as tiny. Frozen requirements, reasoning/fast mode and full checks
remain unchanged.

The same next candidate also performs fresh-session preflight through the existing
authorized guidance and environment tools (and capacity for coordination only),
before first inference. It passes full actual results as recorded tool messages,
emits real UI tool events and checkpoints before inference. Resumed histories do
not repeat prefetch; cancellation and missing permissions/tools are preserved.
No read is removed, summarized, fabricated, moved outside timing or billed as model
reasoning. Regression tests cover complete provider replay, durable ordering,
builder/leader distinction and refusal to infer after unavailable guidance.

Trial `43dbffd4-c742-4681-befd-5e3edfb74524` passed the frozen **562 assertions**
in **357,887 ms**, with **435,460 input / 10,843 output tokens** (**446,303 total**,
235,520 cache-read). Independent full-patch review **rejected its quality**: service
path validation rejects every literal percent character, rather than only the
percent-encoded text prohibited by the original contract. Its own tests reinforce
that stricter behavior for `/%` and `/%zz`; the frozen verifier does not exercise
those valid paths. The verifier was not changed and passing it is not acceptance.
Mandatory guidance prefetch worked live, but serial generation, redundant document
reload and a 75-second final leader review remained. Owned resources and exact
temporary allowance were removed; unrelated resources were preserved.

Next candidate prepares a bounded contract-derived review checklist while builders
work and checks both prohibited inputs and allowed neighbors before acceptance.
Matching archived guidance now gets a fresh current-hash receipt, not another full
body and not an `alreadyInContext` claim. Changed or incomplete documents reload;
original encrypted history remains recoverable through existing authorized tools.

The existing `apply_patches` tool can optionally compose successful batch edits,
project formatting, then all required independent checks through the existing
bounded command/output machinery. Partial edits skip verification, interrupted or
failed formatting skips checks, cancellation propagates, and durable outer-call
identity prevents replay. Edit receipts explicitly precede formatting; final diff
inspection remains required. No duplicate process runner or weaker verification
was introduced. Local verification: 278 test files / 1,428 passes / five platform
skips, typecheck, production build (chunk warning retained), scoped Biome and diff
check. Two additional regression tests passed in a targeted rerun after that full
suite. These are local checks, not a live performance win.

Trial `8391fdc3-95eb-4243-a386-5100d09c1c9d` passed **562 protected assertions**
in **402,635 ms**, with **509,763 input / 8,943 output tokens** (**518,706 total**,
322,560 cache-read). Main-agent complete-patch review passed: exact percent-encoding
predicate with allowed neighbors, whole-string names, ordered errors, prototype-safe
own keys and detached service objects. Only the six authorized files changed.
The combined edit/format/check path executed live, with actual exits and complete
retained outputs. It exposed a warning despite successful formatting exit; the
builder repaired that warning and repeated all five checks. Each full suite passed
202 files / 1,046 tests, taking 70.36 and 70.73 seconds. Final lint/typecheck/build/
focused tests passed too; existing unrelated route/router/chunk warnings remained.
This is not a performance win. Owned resources and exact temporary grant removed
at 2026-10-06 05:44:18 UTC; unrelated resources preserved.

Next candidate archives complete consumed guidance immediately after a completed
implementation/delegation decision, keeping full preflight reading and recoverable
originals. It directs Biome formatting to fail on newly introduced warnings before
long verification, without suppression or unsafe fixes. Independent nontrivial
policy contracts default to parallel owners rather than unsupported assumptions
that shared orientation makes serial generation faster. These are general harness
policies, not task-specific implementations or verifier changes.

The builder soft working-context target is 64,000 tokens (coordination remains
48,000) to leave room for complete preflight before recoverable post-decision
archival. Physical input limits, opaque reasoning, model, Medium reasoning and
Fast OFF remain unchanged. The conflicting long cost-policy paragraph was replaced
with a shorter explicit critical-path policy; trivial or genuinely coupled edits
may still use one builder. Local checks: 278 files / 1,432 passes / five platform
skips, targeted updated context regressions, typecheck, fresh production build with
its existing chunk warning, scoped Biome and diff check. No live win is implied.

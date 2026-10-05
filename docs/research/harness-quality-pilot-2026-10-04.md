# Harness quality and speed pilot — October 4, 2026

Follow-up repairs and a separate parallel comparison are recorded in the
[parallel follow-up](harness-parallel-followup-2026-10-04.md). The results and
unfixed status below describe the original run, not the later working tree.

## Result

The current ytimesy harness did not beat native Codex in this live pilot.
Both passed all three tasks, but ytimesy took 639.375 seconds in total versus
196.616 seconds for native Codex: **3.25 times longer**. Patch review found no
clear code-quality advantage for ytimesy.

This is a small development pilot, not a representative benchmark, parity
claim, or measurement of developer attention saved.

| Task | ytimesy | Native Codex | Protected checks |
| --- | ---: | ---: | --- |
| Single-file branch slug fix | 174.672 s | 41.989 s | Both passed 9 assertions |
| Two independent input parsers | 221.111 s | 67.672 s | Both passed 26 assertions |
| Shared title helper and integration | 243.592 s | 86.955 s | Both passed 9 assertions |

## What was actually run

- GPT-6.1 Sol, Medium reasoning, using the same existing Codex subscription
  backend for both arms. No paid API fallback.
- Native Codex CLI 0.159.2 with its native loop, explicitly configured for the
  subscription Responses transport. This does not test its default login flow.
- ytimesy's actual server worker, ordinary durable turns, VM-backed tools,
  read-only leader, fresh writable builder, completion wake-up and leader review.
  The run used the Node worker, not the Cloudflare Workflow executor.
- Three fixed tasks, one repetition each, separate temporary projects to avoid
  project-memory carryover. The arm order was counterbalanced.
- Identical initial Git commit `ffb92b004ab9901b25df6d6850949455b6513b44`,
  prepared dependencies, and 4-vCPU / 16-GiB / 32-GiB task machines.
- Hidden verifier files stayed outside coding VMs. A pinned, networkless Node
  container graded exported patches against the clean baseline and rejected
  unrelated paths. All three untouched-baseline negative controls failed.
- No follow-up coaching, commits, pushes, pull requests or repository publication.

The harness was the current development working tree, not an assertion that
these changes were already committed at `9f06cca`. Its runtime-source digest
(`src` files plus package.json, lockfile and tsconfig, sorted paths and bytes) was
`7ceb88b4a39f3f8bc50cc9069a1884e8d99f8f1af8b1955a1a4d6fa3c14f46c6`.
The final protocol SHA-256 was
`d3ee82b09a522151bdf018171c46a107f7f23ccf57a95a301210fe0a59b52f7c`.

## Timing boundaries

The table measures each arm's setup, execution, patch export and grading.
Common prepared-checkout creation was measured separately: 3.559, 3.372 and
3.382 seconds respectively. Initial template creation, dependency installation,
worker deployment and failed setup attempts are not included in those table
times. This is not a cold-start user journey measurement.

Excluding grading, execution/export totals were 633.809 seconds for ytimesy and
191.248 seconds for native Codex. Therefore grading is not the explanation for
the large timing difference. ytimesy includes builder provisioning and leader
review; native includes its disposable VM and CLI setup. These are different
harness workflows, intentionally measured rather than removed.

## The important failure mechanism

Unique tool calls were deduplicated by item ID across durable follow-up turns,
because later turns retain earlier transcript items.

| Task | Unique ytimesy tool calls | Admission-lock failures | Model requests |
| --- | ---: | ---: | ---: |
| Branch slug | 39 | 17 | 23 |
| Independent parsers | 40 | 16 | 26 |
| Title helper | 56 | 28 | 29 |
| Total | 135 | 61 | 78 |

All 61 failed calls returned the per-VM preparation-lock error. Parallel tool
calls independently enter `resumeProductVm` / `admitVmResume`, where
`lockedVm` uses a non-blocking PostgreSQL advisory lock. Normal concurrent calls
therefore reject one another and force model retries.

The initial copied-status setup had the same race. A regression test reproduced
it before the fix; serial status writes made the test pass. That narrow fix was
deployed before the final measured run. **The broader tool-call race remains
unfixed**, and its failures are included in the reported times.

The next repair should make ordinary concurrent calls safely share or wait for
VM admission, with bounded cross-worker coordination. It must preserve ownership,
provider runtime caps and fleet/user budget checks, not disable admission.

All three leaders selected one writable builder. There was no multi-builder
parallelism to measure. The unconditional leader/build/review path adds overhead
on tiny changes, but this pilot cannot isolate its exact causal cost from model
latency, lock retries and tool transport.

## Code quality and human involvement

Patch review checked correctness against the requested contract, readable
names/control flow, typed interfaces, unnecessary abstraction, duplication,
dependencies and unrelated changes. This was an inspection, **not an independent
blinded human review or a validated maintainability score**.

- Branch slug: the two patches were identical and minimal.
- Parsers: both were small typed pure functions with appropriate rejection
  guards. Native used one insertion-ordered Set for ports; ytimesy used an array
  plus a Set. Both were readable; ytimesy was longer without a demonstrated benefit.
- Title integration: both added a focused shared helper and preserved explicit
  branch selection. Native's intermediate `titleSlug` made the integration easier
  to read than ytimesy's nested expression in a long template string.

No defects were found within these inspected contracts and verifier cases.
That does not establish correctness on arbitrary codebases or security parity.
Both arms completed the clean run without human rescue prompts. Actual human
attention, review time and number of interventions needed to land a PR were not
measured. CI failure repair, fresh adversarial review, publication and merge were
not exercised.

## Setup failures and cleanup

Before the clean run, setup exposed the copied-status lock race, an exhausted
internal test allowance, and a native proof VM lacking an admission-owner
identity. Those attempts are separate infrastructure evidence, not silently
counted as successful model trials. An additional setup attempt was stopped while
correcting the native-control adapter. Its incomplete results were not pooled.

The native evaluator now allocates an owned disposable session through normal
machine admission. A temporary audited $4 internal allowance was used within the
approved $5 Freestyle cap and withdrawn afterward; the original user policy was
not increased permanently. Reservation records remain for reconciliation.

The evaluator deleted each disposable task tree and pair snapshot. Operator
cleanup deleted the temporary worker, template VM, template snapshot and remaining
interrupted-test projects. Final Freestyle inventory on October 4 at 23:39:21 UTC
contained **zero VMs and zero snapshots**. These test resources are not recoverable;
the local redacted evidence and patches are retained. Nothing was published.
The temporary worker deployment is therefore no longer running.

Exact provider-billed dollars were not reconciled from a wallet statement; no
invented actual-charge figure is reported. Subscription token consumption is not
an API dollar charge. Native enforced a wall-clock deadline but not the same
request/token guard as ytimesy, which limits resource-equivalence claims.

## Evidence and next acceptance gate

Private, ignored evidence is retained under
`.ytimesy/evaluation-current/9cd2abd1-1112-4140-80bd-3a7a703376b4/`:
`protocol.json`, `results.json`, per-arm redacted traces and patches.
`.ytimesy/evaluation-current/cleanup.json` records exact cleanup targets.
Reference prompts, credentials and private raw artifacts should not be committed.

Verification of the integration edits: 26 targeted tests passed; typecheck, lint
and production build passed. These checks are distinct from the live task grades.

First fix and regression-test the admission race, then rerun the same diagnostic
tasks without tuning to their answers. Only after that should larger, held-out
real tasks measure parallel critical-path speed, integration conflicts, CI repair,
review correctness and actual developer interventions. Three tiny tasks cannot
prove a competitive harness advantage.

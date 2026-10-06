# Local harness verification — 2026-10-05

This continues the development evaluation on `codex/realtime-server-delivery`,
from `278daaa9252c55d5199999b4b795c6a5fa63db91`. Cursor PR #16 was not merged.
No production deployment, database migration, or commit/push was performed.
The user authorized the existing Codex subscription and at most $20 total
Freestyle spend for disposable paired tests. Private prompts, credentials,
patches and raw traces remain outside Git in `.ytimesy/`.

## Optimization contract

Minimize time to one integrated, reviewed result and actual attributable
infrastructure/model cost, subject to hard correctness and code-quality gates.
No points are awarded for fast partial patches, weakened/skipped required checks,
edited protected verifiers, operator rescue, or unverifiable acceptance. Code must
preserve existing behavior outside the task, remain readable, and reuse existing
boundaries. Passing assertions alone is not a complete code-quality audit.

Request/token/cache counters are not invoices; reservation upper bounds are not
reconciled spend. Report these separately. Every attempted comparison remains in
the record. This is one known development task, not an untouched holdout or proof
of being the best harness generally. Cross-repository tasks and independent review
are required before making a competitive quality/speed claim.

## Changes and verification boundaries

- Writer acceptance now atomically records the exact inspected SHA-256 and base
  revision in the existing command journal. Imports require that acceptance,
  recheck ownership/review/source identity, serialize through an OS file lock,
  and recover completed applications without applying the patch twice.
- The evaluator grades one actual reviewed integration checkout covering every
  writer through recorded imports. It does not stitch independent patches in
  the grader. A missing, stale, partial or ambiguous integration is rejected.
- Evaluation sessions pin their working and selected branch to the clean
  snapshot's local branch. Registered evaluations skip automatic publication;
  ordinary writable turn publication remains unchanged.
- Repository `read_file` now exposes bounded Unicode-character pages with an
  explicit continuation cursor. Bulk `read_files` retains its prior result
  shape and bounds. Existing repository and `.git` protections are reused.
- Codex subscription requests use a stable, opaque owner/account/chat-scoped
  cache key in both `session-id` and `prompt_cache_key`. A changed account fails
  the turn rather than silently reusing another account's affinity.
- Delegated-task status is append-only: unchanged snapshots are not added, and
  updates never remove or reorder earlier messages, including opaque reasoning.
  A regression failed with the old prefix-rewriting implementation and passes
  with the new implementation. This preserves cacheable prefixes; it does not
  guarantee a cache hit or a speed improvement.

The implementation reuses Git, OS locking, the command journal and existing
file-reading/provider adapters. It does not add a patch parser or database
table. Final local verification passed 249 test files and 1,240 tests, with
three existing skips, using `pnpm test --maxWorkers=2`; typecheck, lint, build
and diff checks passed. The preceding unrestricted full run hit the existing
five-second timeout in two integration tests (Git brokerage and checkpoint
migration); both passed in the bounded full rerun without timeout changes.
Real local Git and PGlite tests are distinct from live model evidence below.

## Development paired evidence

### Deterministic integration follow-up

The cloud harness now offers `integrate_reviewed_tasks` for a fresh writable
direct-child draft and two to eight exact reviewed siblings. It reuses machine
admission, reviewed imports, scoped commands, session items and the task-event
outbox. No integration model is invoked. Baseline verification/dependency-policy
changes, missing checks, conflicts, and failed commands do not produce a verified
result. The lead still reviews the combined diff; this is not automatic acceptance.
Native adapters without cancellable cloud tool context use a builder instead.

The new workflow and real PostgreSQL-compatible recovery tests cover stale hashes
and bases, owner/project boundaries, conflicting imports, altered check scripts,
failed checks, command cancellation, lost lead turns and duplicate recovery.
The first regression run found an ambiguous SQL parameter type in the recovery
query; explicit text casts fixed it. The final bounded full run passed **252 test
files, 1,260 tests**, with three existing skips. Typecheck, lint, production build
and diff checks passed. Updated contract tests cover the additional cancellation
context and the deterministic-tool guidance; assertions were not removed to hide
a behavioral failure.

A new paired run uses the same private task, clean base, model/reasoning, limits
and 562 protected assertions. Runtime file hashes are checked before launch.
No rescue prompts, runtime changes during active turns, publication or production
deployment are allowed. The first deterministic-integration pair (`9351cbfa`)
failed: the tool failed before importing patches, and the autonomous integration
builder fallback exhausted the unchanged deadline before lead acceptance. The
native control passed. This is a failed harness result, not a speed win.

The captured exception was opaque. A separate live disposable binding-only probe
reached the verification-policy boundary, so it did not reproduce the original
failure or prove a specific infrastructure cause. A red-capable unit regression
then established that integration exceptions escape as tool failures without
actionable stage information. Integration now returns a safe structured failure
with the failed stage and predefined error name/code, records it in the child,
and preserves the repair checkout. Unknown raw messages, hosts and credentials
are never returned. Local verification passed 252 files / 1,261 tests, with
three existing skips, plus typecheck, lint, build and diff checks. The second pair
(`7750a707`) also failed at the deadline: two builders were reviewed, while the
third stopped with an evaluation-guard failure after a long interval without
persisted progress. The safe worker diagnostic identifies `evaluation-guard`,
not a proven database/coordination outage. The guard stopped subsequent model
requests. Native passed the same protected verifier in 190,526 ms.

A separate no-inference full integration probe reproduced a baseline-policy
failure. A real-Git regression went red because fresh snapshot checkouts can lack
`refs/ytimesy/base`. The service now reads the exact reviewed base commit and
rejects mismatched HEAD; it does not replace baseline policy with working files.
The full live probe then passed exact imports, lint, typecheck, the complete test
script and build in **108,940 ms**, retaining pending lead review. This proves
the tested deterministic service, not a coding speed advantage. Local verification
passed **252 files / 1,262 tests**, with three existing skips, plus typecheck,
lint, build and diff checks. The unchanged fixed-runtime pair (`27c6c640`) passed
both arms: ytimesy **423,874 ms**, native Codex **192,635 ms**. Ytimesy is still
**2.20× slower** on this task; do not call the optimization target achieved.

That run used two parallel isolated builders; the lead reviewed the first while
the second ran. Both exact patches were accepted before deterministic integration.
The combined workspace passed whitespace, lint, typecheck, the full test script
and build. The lead inspected and accepted the combined patch. There was no API
turn/model inference for the integration child, no fallback integration builder,
operator rescue, changed grader, skipped check, publication or production deploy.

Compared with the earlier passing `53023b25` run, time fell 9.8%, model requests
fell from 76 to 51, and observed tokens fell from 2,421,411 to 1,649,146. These
are observations across stochastic runs with different decompositions, not a
controlled attribution of all improvement to one change. The fixed run reported
1,637,334 input tokens, including 1,410,048 cached (86.1%), and 11,812 output
tokens. The native control reported 316,329 input tokens, 276,224 cached, and
7,285 output tokens. Ytimesy's cumulative input is still substantially higher;
the cached fraction does not establish equal cost or latency. Native request/token
caps remain asymmetric, as documented below. Attributable billing is not reconciled.

The remaining measured overhead is not lack of parallel VMs: the initial lead
turn took approximately 83 seconds, the slower builder approximately 205 seconds,
and the last lead turn (including deterministic integration and combined review)
approximately 173 seconds. Some phases overlap. Removing the integration model
turn fixes one source of overhead but does not close the competitive speed gap.

Disposable cleanup was verified at 19:56:56 UTC: **zero Freestyle VMs and zero
snapshots remained**. The temporary test grant was withdrawn, and private results
were retained locally. No persistent compute, production deployment, Git push,
or Cursor merge was left behind by this evaluation.

The frozen task adds three independent pure setup-policy modules and focused
tests. Both arms use `gpt-6.1-sol`, Medium reasoning, the same clean repository
commit `ffb92b004ab9901b25df6d6850949455b6513b44`, a digest-pinned protected
grader, and a 600-second coding limit. There are 562 protected assertions.
No rescue prompts or paid API fallback are supplied.

| Attempt | ytimesy | Native Codex | Interpretation |
| --- | --- | --- | --- |
| `3d99680f` | Rejected: lazy checkout drifted from frozen base | Infrastructure fetch failure | Invalid pair; retained, not scored |
| `2b46a046` | 581,953 ms; all 562 assertions passed | 326,014 ms; all 562 assertions passed | Correctness pass, speed loss |
| `55347485` | 545,810 ms; all 562 assertions passed; one interrupted builder recovered autonomously | 301,514 ms; all 562 assertions passed | Correctness pass, speed loss; not the renewal-fix revision |
| `53023b25` | 470,082 ms; all 562 assertions passed; failed lead turn followed by autonomous completion wake-up | 221,114 ms; all 562 assertions passed | Correctness pass, speed loss; native HOME corrected |
| `9351cbfa` | 601,883 ms; no accepted combined result before deadline | 179,922 ms; all 562 assertions passed | Harness failure; failed automated integration and slow autonomous fallback |
| `7750a707` | 601,069 ms; two reviewed builders, third stopped at deadline | 190,526 ms; all 562 assertions passed | Harness failure; long builder stall, no accepted integration |
| `27c6c640` | 423,874 ms; all 562 assertions passed; no integration model turn | 192,635 ms; all 562 assertions passed | Correctness pass, speed loss; deterministic integration live-verified |

In the valid pair, three isolated builders started within approximately 167 ms
of one another. The lead yielded, woke on completion, inspected and accepted
exact patches, then delegated combined verification to a fresh integrator.
The integration imported three reviewed siblings; its accepted checkout was
graded. The tree consumed 81 model requests and 2,285,486 observed tokens,
including repeated input context. This is not a context-window measurement or
a dollar invoice. Parallel launch alone did not overcome coordination and
integration overhead.

The valid native control uses the pinned CLI's own coding harness with an
explicit Responses transport to the same subscription backend. It is not a
test of default CLI authentication. Its isolated HOME also caused Corepack
cache-directory errors; it recovered using installed binaries. That environment
asymmetry is corrected for the next comparison: `HOME` points to the prepared
user home while `CODEX_HOME` remains an isolated, disposable directory. The
actual native wrapper has a regression test covering both paths. Request/token limits
are enforced across the production tree, but not yet across the native CLI.

## Cache diagnostic

A separate four-request synthetic repeated-prefix probe used no VM and no
tools. The baseline repetition reported 0 cached input tokens; the affinity
repetition reported 7,680 cached of 7,828 input tokens. This confirms cache-hit
reporting for the tested transport. The cached repetition took 5,647 ms versus
2,482 ms for the baseline repetition, so it does **not** prove reduced latency.
It is not a coding benchmark or evidence of a quality change.

Affinity matches the pinned native ChatGPT transport's documented source
behavior: [Codex 0.159.2 client](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/client.rs)
and [session headers](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/codex-api/src/requests/headers.rs).

## Remaining proof requirements

### Interrupted child and bounded coordination recovery

The `55347485` run reproduced a five-second conversation-renewal timeout.
The worker immediately aborted the builder, classified it as cancelled despite
`cancel_requested=false`, and did not emit a failure event to its parent. The
lead subsequently noticed the idle child when another child's completion woke
it, resumed the same builder, and reached a reviewed integration result without
operator rescue. The interruption is retained in the evidence.

Two deterministic regressions failed before correction: one transient renewal
could not recover, and exhausted heartbeat failures did not finalize as failed
or enqueue a parent notification. The adapter now uses the existing Effect
retry scheduler for **one** identity-bound renewal retry, with a 250 ms backoff
and five-second timeout per attempt. Rejected/cancelled leases are not retried;
authentication errors and ambiguous releases are not retried. Exhausted
heartbeat failures finalize as failed and emit the same safe explanation to the
parent. Explicit user cancellations retain their existing cancellation path.

A separate live deployed-coordinator probe acquired a disposable identity,
delivered a renewal, deliberately dropped its successful acknowledgement, and
recovered through a second renewal. Cancellation then rejected another renewal;
the probe released its lease. No model inference or VM was involved. This proves
that tested failure boundary, not that all network failures will recover. The
coding worker was updated only after its model turns had settled; another
comparison is required to verify the updated runtime in a coding task.

The interrupted coding tree reported 745,728 cached input tokens of 2,064,348
input tokens across its turns. That is actual cache reporting in a coding run,
not proof that cache affinity alone caused its timing difference.

The next tree (`53023b25`) reported 2,094,592 cached input tokens of 2,405,843
input tokens (87.1%), versus 36.1% in the preceding tree. All three builders ran
on separate machines and finished; the lead inspected and accepted their exact
patches. After starting the integrator, a lead turn failed with the generic
progress-saving explanation. The integrator continued and its completion woke
the lead, which accepted the combined checkout without an operator rescue.
The old runtime did not retain enough safe error classification to establish
whether that failure was a database write or coordination release. Do not
assert a specific cause. Local diagnostics now distinguish coordination from
progress saving and log only predefined names/codes, never raw error text,
database hosts, queries, prompts or credentials. Regression tests cover release
timeout classification and arbitrary error-property redaction. These diagnostics
were not added to the runtime during the active comparison.

No Codex-level quality, speed superiority, public benchmark score or final
holdout result is established. One successful private task cannot establish
generalization. Preserve all attempts; use a frozen, separately agreed task
sample and acceptance criteria before claiming a winner. Native request/token
guards, broader environment equivalence and invoice-level spending reconciliation
remain unfinished. The latest comparison took 7m 50s for ytimesy versus 3m 41s
for native Codex. Improved cache reporting and lower ytimesy duration than
preceding attempts do not establish causal attribution: model variance and
the different interruption paths remain confounders.

## Disposable infrastructure cleanup

After both arms settled, cleanup completed at `2026-10-05T18:25:28.148Z`.
The worker, template and remaining private snapshot were deleted. The paired
runner had already removed its execution/grader resources and unbound temporary
projects. The temporary $20 compute adjustment was withdrawn; the user's
underlying policy and source project were not changed. Provider inventory
returned zero VMs and zero snapshots, matching the initial inventory. Exact IDs
and cleanup results remain in the private `cleanup.json`. No persistent compute
was left running. This verifies resource cleanup, not a reconciled invoice.

## Follow-on disposable capability and repair-delivery tests

These are not paired coding benchmarks and do not change the slower native-Codex comparison above.

- Guest references, read-only rename preview and native patch application passed on a disposable 2 vCPU / 4 GiB VM (7,902 ms).
- Remote signed Node/database preflight passed. After correcting the proof packaging, the live Cloudflare run exposed and led to fixes for the vm-prefixed executor allowlist and unsupported `redirect: "error"` mode. Manual redirects are not followed and non-success responses are rejected.
- Final deployed delivery proof: unsigned 401, signed 202, Workflow complete, duplicate delivery retained exactly one pending repair event, zero inference turns. This proves durable signed delivery, not an actual CI/review repair by a model.
- The temporary Cloudflare Workflow/endpoint, executor VM and isolated database fixtures were deleted. Freestyle inventory returned zero VMs and zero TLS rules. VM spending is nonzero and unreconciled; no paid model inference was used in this follow-on batch.
- Full local suite: 273 files, 1,335 tests passed, 3 skipped. Typechecks, lint, production build and diff whitespace checks passed.
- The development repair migration and Checks: read installation permission are applied. The existing shared App webhook remains unchanged. Continuous repair and an always-on executor remain disabled because the user selected disposable tests only.

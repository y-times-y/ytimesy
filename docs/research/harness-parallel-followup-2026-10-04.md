# Parallel harness follow-up — October 4, 2026

This continues the [original three-task pilot](harness-quality-pilot-2026-10-04.md).
The original results are retained, not replaced with improved runs.

## Repairs and proof boundaries

Normal concurrent VM admission now waits for the existing per-VM PostgreSQL
advisory lock rather than returning a preparation error. The lock remains
cross-process; ownership, VM-generation, resource, fleet allowance, and provider
runtime-cap checks still execute inside it. Different VM slugs remain independent.

The database's session pooler did not honor the statement timeout provided at
connection startup: a replacement connection reported `2min`, not the requested
`20s`. Lock acquisition therefore explicitly sets a 20-second statement timeout,
then restores the connection's prior setting before admission work. Acquisition
or timeout-restoration failures destroy the connection; unlock failures also
destroy it. No application-side retry loop or new mutex library was added.
PostgreSQL supplies the waiting lock and statement cancellation primitives.
See [advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
and [statement timeout](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT).

Fresh provider state that already confirms the exact prepaid cap and disabled
automatic restart no longer causes a redundant update and confirmation fetch.
Budget validation still runs; unknown restart state or mismatched caps still
require those provider calls. This saves two provider requests on that path,
not a measured universal latency improvement.

The shared leader policy now calls for simultaneous ready builders on substantial
independent workstreams, with explicit file ownership and shared interfaces.
One builder remains appropriate for small/coupled tasks or constrained capacity.
The three-active-child cap and mandatory review are unchanged. This is model
guidance, not a deterministic guarantee that any particular prompt decomposes well.

## Reproducible admission check

Run against the configured development database:

```sh
node --env-file=.env --import tsx scripts/prove-admission-concurrency.ts
```

This uses only uniquely named disposable advisory locks, not application-record
writes, VMs, or inference. The original version failed with the exact preparation
error on the second concurrent call. The repaired path passed same-slug exclusion,
independent-slug progress, release after operation failure, a real 20-second
timeout without entering the protected operation, and restoration of normal
settings on a replacement pooled connection. Unit tests separately assert
connection disposal on uncertain acquisition and unlock failure.

## Live comparison scope

A new development fixture requests three independent pure project-configuration
policies and their Vitest tests: package-manager lockfiles, environment-variable
validation, and service declarations. Both arms receive identical contracts;
protected correctness checks stay outside coding VMs. This is a development
fixture, not a representative public benchmark or production feature rollout.

The live leader drafted three writable children with distinct file ownership.
Their durable turns started at `00:00:12.065`, `00:00:12.159`, and `00:00:12.230`
UTC on October 5: a 165-millisecond spread. All three were observed running on
distinct Freestyle VMs. The leader yielded its turn for completion notifications.
This establishes parallel launch, not successful integration or superior speed.

## Completed parallel comparison

Both arms used GPT-6.1 Sol at Medium reasoning through the existing Codex
subscription, the pinned clean checkout, and identical prepared machine resources.
There was one run per arm, with no human rescue prompt. This is not a statistical
estimate of overall harness performance.

| Arm | End-to-end time | Corrected protected checks |
| --- | ---: | --- |
| ytimesy, three parallel builders | 333.939 s | 562 passed |
| Native Codex | 265.701 s | 562 passed |

ytimesy was 25.7% slower, despite verified simultaneous builder execution. The
three builders finished between 154 and 204 seconds after launch. The leader
woke and reviewed the first completed child while the others remained active;
it finished reviewing all children before the final response. Parallelism worked,
but preparation, repeated inspection, model turns, and review still outweighed
its benefit on this fixture. These observations do not establish which change
would improve a representative larger task.

The ytimesy trace contains 94 distinct tool calls and 52 model requests across
the leader and builders, with 1,140,578 observed tokens. Native Codex contains
17 completed command calls and reports 397,110 input tokens (353,920 cached)
and 6,799 output tokens. The token counters have different semantics and must
not be treated as a like-for-like billing comparison.

There were zero admission-preparation failures in the ytimesy run, compared
with 61 in the original pilot. Two file reads failed: an out-of-repository
environment-report path, and a child-created file absent from the leader's
separate checkout. Reviewing separate child diffs worked; reviewed does not mean
merged into the root checkout. The fixture did not test publication or integration.

Both arms encountered a missing `pnpm` shim in the private prepared snapshot,
although dependencies were installed. They recovered with installed local
executables. This is a fixture setup defect, not evidence of a production
environment defect. Future preparation now enables Corepack and checks the
`pnpm` command; the active snapshot was not changed during this comparison.

### Verifier correction, without changing either implementation

The original verifier wrongly required a normal object prototype for environment
variables, although the contract allows a null-prototype dictionary with exact
own keys and values. It rejected ytimesy and accepted native Codex. Both original
grades are retained. The corrected verifier checks exact own keys and values,
error precedence, and the unchanged contract. Both unchanged patches passed all
562 assertions; the untouched baseline failed. No model was rerun or coached to
repair this grader defect. Original measured timings remain unchanged.

Original verifier SHA-256:
`e4fcc78fd8cffec8bd90a8aba775960ba62b3e382fcd9231cea715da1e4f0561`.
Corrected verifier SHA-256:
`28f9b2e4b9a2b1c18e6ee68d6bf3ebb067587b699c8d5763dcf5490b538acb3c`.
Raw evidence remains in the private operator directory
`.ytimesy/evaluation-continuation/a252c70a-6458-423c-9fba-97978bb71fe4`;
it is intentionally excluded from commits.

### Code quality inspection

Both patches use focused pure functions, typed error unions, explicit ownership
of returned data, and tests for validation precedence, boundary values, special
property names, and input mutation. Neither adds dependencies or changes setup
execution. ytimesy's null-prototype dictionary safely preserves `__proto__` as
an own property; native Codex uses `Object.fromEntries` for the same behavior.
No concrete correctness defect was found within the stated contracts. This was
manual, unblinded inspection, not an independent maintainability assessment or
proof that either harness produces better code generally.

The final production build passed. Before the extra timeout-restoration test,
the full serial suite passed 1,159 tests with three skips. The updated admission
and usage suites passed 27 tests, including restoration-failure disposal.
The real database concurrency proof passed again against the current source.

## Original small-task regression

The unchanged `small-branch-slug` prompt and protected checks were run again:
ytimesy took 155.375 seconds and native Codex 48.243 seconds. Both passed all nine
protected assertions. The original ytimesy result was 174.672 seconds, but this
single rerun is not a causal latency estimate for the lock repair. ytimesy still
took 3.22 times as long as the concurrent native control. One builder is the
coherent decomposition for this small change; extra builders would be filler.

## Bounded grouped inspection

The traces show repeated individual file reads. Read-only leads cannot substitute
an arbitrary shell command for those reads. The existing file-tool module now
adds `read_files`, using the existing VM execution path and Python standard-library
path/file handling rather than a new orchestration dependency. Up to eight known
files are returned in request order in one command; content is bounded to 32,000
characters per file and 64,000 total. Truncation is explicit. Absolute paths,
resolved paths outside the repository, `.git` paths and symlinks into `.git` are
rejected. A missing requested file fails the inspection instead of returning an
apparently complete partial result. The original single-file tool is unchanged.

New regressions failed before the implementation and passed afterward. Tests
execute the actual guest Python locally, including valid Unicode and quoted names,
size/count bounds, missing files, and existing out-of-repository symlink targets.
A real Freestyle test read AGENTS.md, package.json and the self-documenting-code
skill in exactly one command, without truncation or repository edits. The updated
full suite passed 1,165 tests with three skips; lint, typecheck and build passed.

The second paired run used the same prompt and prepared snapshot. Both arms
passed the same 562 protected checks: ytimesy took 351.347 seconds; native Codex
took 281.316 seconds. ytimesy used 63 distinct tools, seven grouped reads and 65
model requests. Fewer tool calls did not produce a speed improvement. The three
builders started across separate model steps, with a 17-second spread, despite
running concurrently afterward. Raw evidence is retained privately under
`ee78c1c0-7a7d-4f99-8698-2ec84b90a8d7`.

## Third run: integration failure, not a successful speed result

The next policy adjustment limits the lead's initial investigation to safe task
ownership, shared interfaces, dependencies and required repository preflight.
Owning builders still perform deeper reuse checks and provide verification
evidence. The lead may continue independent investigation while they run; the
change does not waive preflight, tests, or review.

In the third live run the three builders started within 193 milliseconds on
separate machines, and each initially finished its implementation and tests.
However, the lead attempted to consolidate their changes before completion.
The root is read-only; the available Git broker publishes individual reviewed
tasks but does not provide unpublished integration of sibling working-tree
patches. `inspect_task_diff` is restricted to descendants, so the designated
builder could not inspect sibling diffs directly. The lead then used peer
messages to resend source text and task-control messages to expand one builder's
scope. That caused more model work and the integration turn hit the 600-second
guard before combined verification and review finished.

The ytimesy arm failed the harness completion gate at 601.990 seconds. It is not
a correctness pass or a successful integrated result. Its evidence is retained
under `7bbd539c-908e-4b1c-a23a-0a0e089681b1`. Native Codex completed in
340.833 seconds and passed the same 562 protected checks. Unlike the first two runs, the external grader could not
proceed because a builder was cancelled with review pending.

The first two runs' protected verifier assembled separate reviewed patches
outside the product. Those results establish contract correctness of the
exported patches, not a verified in-product integration or PR workflow. The
third run exposes that limitation directly. Completion notifications and lead
reviews were observed; the problem was not an asleep lead. The next necessary
workflow repair is authorized, conflict-safe unpublished Git patch transfer to
a distinct writable integration checkout, followed by combined verification.
It must not grant shell writes to the read-only lead, bypass review, silently
publish, merge across competition groups, or resend source through the model as
the normal transfer path. The implementation and bounded proofs below address
that gap; they do not retroactively turn this failed run into a pass.

## Prepared-environment report access

The live traces also reproduced an instruction/tool mismatch: shared setup
instructions name `/tmp/ytimesy-environment.json`, but repository readers reject
out-of-repository paths. `read_environment_report` now provides fixed-path
read-only access without arbitrary path selection. It returns explicit absence,
pages at 32,000 characters, preserves Unicode, bounds offsets, and rejects
symlinks and non-regular files. The API turn instructions name the appropriate
tool. Historical metadata remains untrusted evidence requiring checkout checks.

Targeted tests passed 29 checks across file tools, aggregate tools and API turns.
The complete serial suite passed 1,168 tests with three skips; lint, typecheck
and production build passed. A real disposable Freestyle VM verified explicit
absence and two-page Unicode reconstruction using synthetic report content.
This validates the reader, not genuine setup success or recorded baseline
checks. The new report tool was added after the third run started and was not
deployed to that frozen evaluation worker. No superiority claim is justified
by the completed results.

## Reviewed patch integration repair

`import_reviewed_task` is a builder-only task tool. A fresh writable integration
child can import completed, reviewed siblings under the same parent, owner and
project. Competing candidate leaders, read-only/shared tasks, active/unreviewed
sources and self-imports are rejected. The parent supplies the SHA-256 returned
by `inspect_task_diff`; changed patches require new inspection/review. Diff
inspection pages at 60,000 characters with an explicit next offset and a hash of
the full captured patch. Review status is checked again after export.

The transfer reuses Git rather than asking a model to reconstruct source. A
temporary index captures staged, unstaged and untracked changes, including binary
patches, without changing the source index or making commits. Transfers are
bounded to 8 MiB. Base64 preserves patch bytes across the existing text transfer
API. On the destination, Python's standard-library `fcntl` provides an OS file
lock around base-revision comparison, `git apply --check` and atomic `git apply`.
No new package, database migration, GitHub credential or forced conflict resolution
is introduced. Failed/conflicting imports require inspection, not blind retries;
durable task-tool receipts retain the existing uncertain-outcome behavior.

The integration child is explicitly responsible for combined verification and
must obtain its own parent review. Import does not publish, constitute final
acceptance, or update the read-only root checkout. The lead's shared policy now
requests a distinct integration child with explicit combined ownership, sibling
IDs and inspected hashes rather than expanding an existing task through peer
messages or transmitting source through chat.

Local real-Git regressions cover source-index preservation, staged/unstaged/new
files, deletions, Unicode, binary bytes, conflicts without partial application,
different base commits, concurrent overlapping imports, scope denial, changed
review state and source edits after inspection. A real development fixture used
two separate source Freestyle VMs and a third integration VM through the actual
workspace resolver and owner-scoped admission path. Both hash-matched patches
were imported with exact fixture contents. The read-only lead was rejected and
an overlapping repeat import failed. It used no model inference, publication,
or user-repository changes; fixture records and machines were removed afterward.
Evidence is private in `reviewed-import-proof.json`.

This is a live tool/workspace proof, not proof that a model will choose the
right integration plan, a newly passing end-to-end benchmark, or superior speed.
The old status-plus-diff script was replaced by the captured Git patch path and
removed, rather than retaining two implementations of task diff export.
The failed benchmark remains failed. These changes are local source changes;
the frozen benchmark worker was not silently updated during either arm.

Final serial validation passed 239 files, 1,183 tests and three skips. After
that suite started, the additional destination-symlink regression was added;
the complete 16-test integration file passed separately, including that case.
Lint, application/workflow typechecks, production build and `git diff --check`
passed. The build still reports its existing large-chunk warning; it is not
suppressed or presented as a runtime-performance proof.

## Cleanup

At `2026-10-05T00:49:21.988Z`, provider inventory confirmed zero VMs and zero
snapshots. All benchmark/proof projects were removed, the temporary three-dollar
admission adjustment was reset to zero, and the database had no queued/running
API turns. Raw redacted/private benchmark evidence remains available locally;
disposable workspace edits were not published. Test usage reservations remain
protected for reconciliation; cleanup does not claim an exact invoice cost or
refund unverified holds.

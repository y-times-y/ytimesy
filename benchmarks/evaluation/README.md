# Production harness evaluation

This is an operator-only development evaluation bridge, not a second model loop and not a claim of Codex parity. It does not import PR #15. The baseline for this work is `9f06cca14599463f2e185874258f5eb2d6c9e3b1`.

## What runs

`production.ts` creates a disposable chat in an existing, operator-owned, prepared project. It uses `sendHarnessWorkspaceTask`, the durable production queue and the ordinary leader/builder/reviewer tools. Completion requires the entire child tree and completion outbox to settle. Every writable builder must be done, reviewed and on a distinct execution VM. Publication through `publish_task` is disabled for evaluation descendants.

`native-codex.ts` runs pinned native Codex CLI on a disposable snapshot of the same initial clean environment, at the same model, reasoning, prompt and Git commit. Only a short-lived subscription access credential and identity token enter that control VM; refresh credentials and application authority remain server-side. Its explicit Responses provider uses the same existing Codex subscription backend as production; this is a transport-configured native harness, not a test of the default CLI workspace-routing authentication. The native process has a wall-clock deadline and its VM has a TTL. The native control does **not** currently enforce the product's request-count/token guard. Its network/sandbox policy differs from the production execution path, and builtin connector startup can fail independently. Therefore these runs are development diagnostics, not an equivalent-budget final comparison.

As of 2026-10-06, the disposable VM is the native control's OS isolation
boundary (`--sandbox danger-full-access` inside that VM). Product guest commands
already use that VM boundary. A zero-inference reproduction found that adding
Codex's nested `workspace-write` sandbox only to native causes unchanged daemon
tests to fail with `spawnSync python3 EPERM`; the full-suite control timed out.
That failed control is retained and must not be counted as a harness advantage.
No host execution, refresh credentials or application authority is granted by
this change. Native results record `executionIsolation: disposable-vm`.

`grader.ts` clones the local repository at the pinned task commit, integrates returned patches, rejects edits outside the explicit allowed paths and runs a hash-pinned verifier in a networkless, capability-restricted Docker container. The verifier is not sent to either coding agent. Image, verifier hash and commit availability are checked before inference. Use an image that already contains test dependencies: grading cannot download them.

`harbor_agent.py` is a Harbor 0.23.0 external agent adapter. It invokes the same production bridge and applies the reviewed patches in Harbor's verifier environment. It rejects differing instructions, model IDs or commits. It supports tasks mapped to prepared, authorized Git repositories; it does **not** yet import arbitrary Terminal-Bench filesystem environments into Freestyle. Keep that distinction in reports.

## Preconditions before a live pilot

1. Obtain a new explicit model-billing and VM spending approval. Old approvals are not reusable. Subscription quota is still consumed, even without API charges.
2. Apply `supabase/migrations/20261003010000_harness_evaluation_limits.sql` to **development only**, with approval, after migration tests pass.
3. Deploy this source to the actual durable worker and set `YTIMESY_HARNESS_EVALUATION_ENABLED=1` in its environment, and in the operator process. Verify its deployed source revision and guard configuration before submitting a task. A flag on the laptop alone does not prove the remote worker has the guard.
4. Prepare a fresh evaluation project/environment without other conversation history, project briefings, previous solution artifacts or credentials outside the task's needs. Use non-production repositories. Provisioning/binding are real operations, not simulated CLI calls.
5. Freeze a protocol JSON conforming to `src/domain/harness-evaluation.ts`: immutable dataset/source/task commit hashes; model and reasoning; fixed prompts; repetitions/seed; digest-pinned grader image; explicit allowed file paths; verifier path, command and SHA-256; wall-clock, request and observed-token thresholds. The verifier command is `["/operator/protected/verifier.cjs", "node"]`: the first entry identifies the protected asset; the remaining argv invokes it inside the grader as `/verifier`.
6. Verify current VM prices, capacity and a conservative maximum resource envelope against the approved spend **before** launching. The bridge does not pretend token limits are dollar caps. Product thresholds are checked before requests and after usage arrives; concurrent in-flight responses can overshoot the observed-token threshold. No API billing fallback is permitted.

## Reproducible local setup

For a broader development campaign, prepare a private manifest containing
`version: 1`, the committed `harnessRevision`, the existing `protocol` object,
and `assignments` entries with `taskId` and `category`. Categories are
`navigation`, `repair`, `multi-file`, `verification`, `coordination`, and
`long-context`. Use at least two distinct problems per category, twelve total,
three repositories and two repetitions. Repetitions and renamed identical
problems are not independent samples. These minimums are development sampling
guardrails, not a power calculation or final parity criterion.

```sh
node --import tsx scripts/prepare-harness-campaign.ts \
  /private/campaign.json /private/new-campaign-directory
```

Preparation validates the manifest and local harness revision, then writes
private campaign/protocol files without inference, deployment or billing.
Use the resulting protocol with the existing paired runner only after all live
preconditions above are satisfied. Local revision availability does not verify
the deployed worker. No real campaign task selection or run is implied by the
synthetic validator fixtures.

Use Python 3.12 with an isolated, ignored environment:

```sh
uv venv --python 3.12 .ytimesy/evaluation-venv
uv pip install --python .ytimesy/evaluation-venv/bin/python -r benchmarks/evaluation/requirements.txt
```

After the preconditions are verified, run:

```sh
YTIMESY_EVALUATION_APPROVED=codex-subscription \
YTIMESY_HARNESS_EVALUATION_ENABLED=1 \
YTIMESY_EVALUATION_USER_ID='<operator-user-id>' \
node --env-file-if-exists=.env --import tsx scripts/evaluate-harness.ts \
  /private/protocol.json /absolute/local-repository /private/results
```

The output directory is private (0700; files 0600). Keep protocols, task content, raw patches, results and screenshots out of Git. JSON traces are redacted, but a patch can itself contain proprietary code; never publish raw evidence without a separate review.

Generate a descriptive paired report with:

```sh
.ytimesy/evaluation-venv/bin/python -m benchmarks.evaluation.report /private/results/<run-id>
```

Reports reject missing/duplicate arms and changed protocol hashes. Infrastructure failures remain in the denominator. Repetitions are averaged per task before task-cluster confidence intervals, rather than being treated as extra independent problems. Small/constant samples have no reported interval. No automatic acceptance or parity decision is made.

## Stop and recovery

SIGINT/SIGTERM requests graceful cleanup. Production cleanup closes the durable guard first, cancels the tree and destroys only that disposable tree. Native cleanup destroys its exact proof VM. Snapshot cleanup destroys only the snapshot created by this run. `active-attempt.json` identifies the attempt for recovery. SIGKILL, host loss and provider cleanup failures still require operator reconciliation; do not assume a `finally` block survived a crash. Check the actual Freestyle inventory and pending turns after every pilot.

## Acceptance is still separate

Passing bridge tests proves evaluator mechanics, not coding quality. Before a final holdout run, agree on a non-inferiority margin, a statistically justified independent task count, a budget and equivalent resource/network policies. Freeze the improved harness revision, keep final verifiers/reference answers inaccessible to tested agents, and do not tune against final holdout outcomes. The CLI currently rejects `phase: "holdout"` deliberately. Public benchmark results and production-product holdouts must be reported separately. Benchmark metadata and pins are in `docs/research/harness-benchmark-sources-2026-10-03.md`.

## Verification commands

```sh
pnpm exec vitest run tests/harness-evaluation*.test.ts src/server/services/api-agent-runtime.test.ts --maxWorkers=2
YTIMESY_TEST_GRADER_IMAGE='node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f' \
  pnpm exec vitest run tests/harness-evaluation-grader.test.ts --maxWorkers=2
.ytimesy/evaluation-venv/bin/python -m unittest benchmarks.evaluation.test_report
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

The Docker image above is the locally verified test-fixture image, not an assumed benchmark grader image. A skipped Docker test is not live grading proof.

# Verification — 2026-10-03

Implementation is on the existing `codex/realtime-server-delivery` working tree, based on `9f06cca14599463f2e185874258f5eb2d6c9e3b1`. PR #15 was not imported, merged or deployed. Changes remain uncommitted.

## Independently reproduced runtime regressions

Before the shared-loop fix, `pnpm exec vitest run src/server/services/api-agent-runtime.test.ts --maxWorkers=2` failed two assertions:

- Compaction plus final generation emitted cumulative usage of 6 input / 4 output tokens, but completion reported only 3 / 2.
- An aborted run deadline still reached the compaction provider once, where zero inference calls were expected.

After using one run signal for compaction and generation, checking it before inference, and emitting accumulated completion usage, both assertions passed. These are provider-fixture tests, not live quality results.

## Current verification

| Command | Result |
| --- | --- |
| `pnpm exec vitest run --maxWorkers=2` | 218 files passed; 1,010 tests passed, 3 skipped; exit 0 |
| Digest-pinned Docker grader plus targeted evaluator/runtime tests | 4 files, 26 tests passed; exit 0 |
| `.ytimesy/evaluation-venv/bin/python -m unittest benchmarks.evaluation.test_report` | 4 tests passed; exit 0 |
| Harbor 0.23.0 adapter import | `ytimesy-production`; exit 0 |
| `pnpm typecheck` | exit 0; existing route-generator circular-dependency warning |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0; existing large-chunk warning |
| `git diff --check` | exit 0 |

The full suite skips the Docker integration test without its opt-in image variable, plus two existing skips. The targeted run supplied `YTIMESY_TEST_GRADER_IMAGE=node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f` and actually executed Docker verification. The real Git check confirmed staged, unstaged and untracked changes export without modifying the working index. A valid protected-path patch was rejected before executing its code. The Docker fixture verified credentials and Git metadata were absent.

The production-service tests mock external services. They cover normal send-path arguments, pin/cleanliness failure cleanup, waiting for children and completion delivery, reviewed isolated builders, and guard-before-cancel cleanup ordering. They do not prove deployed behavior.

## Development deployment and live diagnostics

- With explicit approval, the additive evaluation migration was applied to the linked **development** database. Its user foreign key targets the existing `auth_user` table. A first attempt with the incorrect table name rolled back; the corrected migration passed its fixture and deployed transactionally. Both evaluation tables have RLS enabled; the authenticated role cannot select their rows.
- The existing development worker was redeployed, only when no model turns were running. The remote process and `YTIMESY_HARNESS_EVALUATION_ENABLED=1` were verified. Production was not changed.
- The connected catalog contains `gpt-6.1-sol` with `medium` reasoning. The private paired plumbing diagnostic uses that exact selection and the Codex subscription, without API fallback. The approved incremental VM budget is $5.
- Both coding arms start from the same clean snapshot revision. The source project's snapshot metadata was stale: two disposable copies independently showed the actual Git revision. Only the disposable evaluation project's metadata was corrected; the user's project and shared snapshot were preserved.
- `agent-browser` inspected the live chat. The leader's grouped work, expandable builder card, nested child session, model label, context ring and waiting-for-children status were visible. Screenshots and private traces are not committed. DOM/UI inspection is separate from provider execution and protected grading.

## Failures found by the live pilot

These iterations use one private development task, **not a public benchmark or final holdout**. Failed attempts remain in private evidence; protocol-changing iterations must not be pooled into a score.

1. Internal child starts discarded the leader's Medium reasoning selection. The durable evaluation guard refused the mismatched request before inference. Internal subscription turns now inherit the nearest owner-scoped, same-model subscription selection; explicit composer selections remain authoritative. Mocked and real PGlite ancestor/ownership regressions cover this fix.
2. A running child could receive a second-turn request from `send_task_message`, which failed rather than delivering guidance. Active-task guidance now uses the existing peer mailbox; idle followups still use the ordinary turn path. Actual handler and peer-delivery fixture tests pass.
3. The leader repeatedly polled working children and exhausted the shared request allowance. Root-role instructions now explicitly yield once independent work is finished; completion delivery wakes the leader for review. The subsequent live runs showed the leader yielding and the builder continuing on a distinct VM.
4. Default native CLI authentication returned workspace-routing 401s. The native control now uses an explicit Responses provider on the same existing subscription backend. Two later native control runs passed all 20 protected assertions. This validates that configured transport and coding control, **not** the default CLI authentication flow or builtin connector access.
5. Later production attempts were stopped by a heartbeat/control-service interruption before builder completion/review. Correct source code and the builder's own passing tests did not bypass acceptance: the evaluator rejected those runs. Safe stop messages and redacted stage/error classifications were added; raw database error text is never logged. An independent no-inference probe completed 80 database queries and 80 coordination renewals successfully, so it does not reproduce or rule out the intermittent fault.

## Successful final development smoke pair

The subsequent pair passed both protected grading runs:

| Arm | Observed result | Duration |
| --- | --- | --- |
| Production ytimesy | Leader delegated to one distinct writable VM, yielded, was automatically awakened by completion, reviewed the builder, and exported its accepted patch. All 20 protected assertions passed. | 175,718 ms |
| Native Codex CLI control | Configured subscription transport, same task/model/reasoning/initial commit. All 20 protected assertions passed. | 79,286 ms |

The production guard recorded 20 model requests and 287,102 observed tokens across the tree. Those input tokens include repeated context across steps; they are not a context-window measurement or dollar invoice. The paired report correctly reports one independent task, no confidence interval and no acceptance/parity decision. Earlier failed runs were retained separately rather than hidden or mixed into this changed protocol.

All completed attempts destroyed their disposable VMs and run-created snapshots, removed their temporary project rows, and returned to the original 16-machine inventory. The existing worker and user machines were preserved. The final independent inventory check found no additional VMs; the database check found zero queued/running turns and zero remaining temporary project rows. VM resource envelopes are bounded and below the approved cap at published rates; this is not an invoice-level accounting audit. Subscription quota was consumed, not paid API inference.

## Not yet verified or completed

No public benchmark score or final holdout result has been produced. The successful final smoke pair and rejected earlier attempts are plumbing evidence, not a parity claim. The final run had no heartbeat interruption, but that does not identify or fix the intermittent interruption observed in earlier runs. Its cause and correction remain unverified; the deployed safe diagnostics are there to capture a recurrence.

Arbitrary Harbor task-environment/project import is still missing. The current bridge only handles prepared, authorized Git repository tasks. Native request/token guards and production/native network/resource equivalence are not established. A final non-inferiority margin, sample size and spending approval are not agreed. Final holdout execution is intentionally disabled. These are remaining requirements, not proof of Codex-level coding quality.

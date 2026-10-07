# Live Harness Mechanics Proof

October 6, 2026. Frozen application runtime:
`c00700c` on `codex/harness-remaining-gaps`. The operator proof scripts added
afterward do not change application code. This is live functional evidence,
not a Cursor comparison, representative benchmark, or protected holdout.

The user approved up to $10 for disposable development VMs and live evaluation.
Only existing Codex subscription inference was used. No API billing fallback,
shared worker deployment, migration, admission allowance change, PR publication,
or modification to the original checkout occurred.

## Actual Linux And Database Execution

The actual completion-verification and baseline services executed against a
new Freestyle Ubuntu VM and the approved development PostgreSQL database.
The VM reported Linux, Node 24.21.0, Git 2.43.0 and Python 3.12.3. Commands used
the production output-artifact and Linux `/proc` process-scope implementations;
none of those services were mocked.

Passed observations:

- A pristine checkout established an owner-scoped server baseline.
- Required Git whitespace and Node checks produced real zero-exit output
  references and a receipt bound to the whole tree and binary patch.
- A second observation reused that exact receipt with two snapshots and no
  repeated check. An external counter recorded exactly one Node check.
- A different owner could not read the receipt.
- The verified tree committed through the actual low-level commit implementation.
- A check exiting 7 produced no successful completion receipt.
- The commit implementation rejected a stale verified tree.
- A newly created undeclared file during checks invalidated verification.
- Changed check policy was rejected without executing the changed command.
- Redefining the guest baseline ref was rejected against the database baseline.
- Cancellation stopped an actual owned Linux process, returned exit 143 and
  confirmed its `/proc` entry was absent.

The initial operator fixture omitted the required workspace foreign key and
failed during setup. It was cleaned up, fixed, and rerun. This was not a
production harness failure or a passing model trial.

## Live Model And Tools

A separate tiny CommonJS multiplication-repair fixture used the actual
`runCodexSubscriptionAgent` model loop, production `read_files`, function-based
`apply_patch` and `run_checks` tools, their owner-scoped journals, output capture,
and the final completion-verification service. The harness also supplied its
automatic tool-discovery surface. The operator invoked the loop directly;
the durable queue and production lead/builder admission were not exercised.

Protocol: fixed GPT-6.1 Sol, Medium reasoning, Fast off, maximum six model steps,
2,048 output tokens per response, a three-minute deadline, no compaction, and a
30,000 estimated-history-token limit before each step. SDK request-start retry
remained bounded at one retry; model steps are not transport-attempt counts.
No rescue prompts were sent and no application runtime code was changed.

The first model trial failed because the proof's restricted VM adapter exposed
`exec` but not `writeTextFile`. The actual patch tool returned explicit failures;
the model inspected the unchanged source, then observed a genuine failed check.
The six-step limit ended the trial. Its checkpoint is retained and it is not
counted as a success. That adapter was corrected without changing the task,
model, reasoning, production tool implementation, or check requirements.

The corrected trial:

| Observation | Result |
| --- | --- |
| Model/tool-loop duration | 18,746 ms |
| Model steps | 5 |
| Tool calls | read, patch, check, read |
| Changed paths | Only `math.cjs` |
| Baseline completion gate | Passed |
| Independent post-run assertions | 12 passed |
| Input / output tokens | 7,562 / 216 |
| Reported cache-read tokens | 3,456, a subset of input |

The independent assertions were supplied only after the model finished and ran
inside the disposable VM. They are not a protected external grader. This one
trivial repair proves a functioning model/tool path, not general coding quality,
parallel orchestration, context recall, PR repair, or competitive performance.
The failed model trial also consumed subscription quota; its complete numerical
usage was not retained by the initial proof adapter, so the table is not total
quota consumption for this proof session.

## Search On The Target OS

The existing reproducible synthetic search benchmark and actual indexed-search
implementation were hash-recorded, bundled with esbuild, and run on a separate
2-vCPU / 4-GiB Ubuntu VM. Each corpus has exactly 16, 32 or 64 MiB of ASCII,
64-KiB code-shaped files and a rare marker. All 18 cold, warm, edited and absent
queries matched native Git stdout, stderr and exit status. All files were indexed.

Observed guest-local timings in milliseconds, including per-command shell/process
startup but excluding the outer Freestyle API round trip:

| Corpus | Git Cold | Index Cold | Git Warm (3 Runs) | Index Warm (3 Runs) |
| --- | --- | --- | --- | --- |
| 16 MiB / 256 files | 231 | 1223 | 202-285 | 254-300 |
| 32 MiB / 512 files | 209 | 2066 | 253-265 | 241-304 |
| 64 MiB / 1024 files | 212 | 3907 | 268-319 | 308-320 |

Some individual indexed samples were slightly faster, but the data shows no
consistent warm-search advantage. Cold index construction costs substantially
more than a native scan. Three repetitions on synthetic files in one VM do not
provide representative estimates or confidence intervals. Git remains the
default; experimental indexing remains opt-in. No Cursor search was measured.

## Cost, Cleanup And Reproduction

Five proof-owned small VMs were created in total, including failed fixture
attempts. Each had a ten-minute TTL and maximum total runtime, no automatic
restart, and immediate deletion on stop. At the currently published standard
rates, their aggregate maximum allocated compute/storage envelope is below
$0.12. This excludes transfer, account-plan billing and unrelated existing VMs;
it is not invoice-reconciled actual spend. Subscription quota is separate.
[Freestyle usage pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits#usage-pricing)
was checked using agent-browser before launching.

Every owned VM and synthetic database project was confirmed absent after its
attempt. Other agents' VMs, prepared snapshots, worker, active turns, grants and
checkouts were left untouched. A concurrent evaluation worker and active turns
prevented safely replacing the shared runtime for a frozen paired run.

Private evidence remains under this worktree's ignored `.ytimesy/` directories:
`live-harness-proof-c00700c`, `live-harness-proof-c00700c-2`,
`live-harness-proof-c00700c-model`, `live-harness-proof-c00700c-model-2`,
and `live-search-proof-c00700c`. Checkpoints, raw receipts and resource IDs are
not committed. Directory/file modes are 0700/0600.

After obtaining fresh approval and setting the development credentials and
`YTIMESY_EVALUATION_USER_ID`, reproduce with:

```sh
node --env-file=/absolute/development/.env --import tsx \
  scripts/prove-harness-verification.ts --live 10 \
  /absolute/development /private/new-proof-directory --model-smoke
node --env-file=/absolute/development/.env --import tsx \
  scripts/prove-repository-search-linux.ts --live 10 /private/new-search-directory
```

These commands require new, nonexistent output directories and validate the
declared spending cap before their setup and provisioning operations.
The declaration is not a provider invoice cap. SIGKILL/provider failures still
require reconciliation using the private resource records; a TTL is a backstop,
not evidence that cleanup already happened.

## Not Proven

There is no Cursor control, matched native control, representative task sample,
live PR-repair execution, worker-restart proof, or production rollout in this
session. Passing these probes cannot justify saying all Cursor advantages have
been absorbed. They establish specific mechanisms and reveal a remaining search
performance gap. Broader paid evaluation still needs an exclusive frozen
development runtime and equivalent control policies.

Local regression validation passed 295 test files and 1,546 tests with five
pre-existing skips. Final invocation-guard coverage was then expanded to both
proof commands and passed eight cases. Application TypeScript and full lint
passed. The application source remains unchanged from the previously
production-built frozen runtime; proof scripts were not deployed to a shared
worker or merged into the original checkout.

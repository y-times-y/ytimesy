# Local builder Terminal-Bench pilot

Status: in progress. This is not a benchmark superiority claim.

## Isolation and configuration

The operator approved a fresh $5 disposable Freestyle cap and existing Codex subscription. No API-paid fallback, production migration, Supabase storage request, or persistent machine is authorized by this pilot. The isolated `codex/builder-core-tools` checkout runs the builder only, without a leader, delegation, review or publication. The browser/UI and production queue are outside scope.

Four original task prompts, pinned task/verifier images and declared artifacts are used in order: session-window-debug, wal-recovery-ordering, nextjs-performance, bun-sourcemap-leak. Each gets one model attempt. The first three are familiar evaluation tasks, not unseen holdouts. Hidden tests run on a separate verifier VM and are never exposed to the builder. Passing these tests is not independent proof of general code quality.

During Next.js, the operator withdrew the fourth task: finish Next.js and its grader, then stop. A private campaign `stop-new-tasks` marker blocks later invocations before credential lookup, database creation, VM allocation or inference. A no-resource Bun preflight verified this intentional early rejection. Bun is not a failed model attempt; it is cancelled by the operator.

Model: GPT-6.1 Sol through the subscription transport, Max reasoning, Fast explicitly off. Limits: 128 model requests including native compaction, 4 million reported input-plus-output tokens, 30 minutes per builder turn. Cached tokens are already included in input. Guest resources: 2 vCPU / 4 GiB host with a 16 GiB disk; original task containers and sidecars share that allocation.

The Supabase quota blocker is bypassed only in this evaluator: encrypted local archives use the existing history recovery/search APIs; a disposable loopback PostgreSQL container receives the operator's genuine local Codex identity and an encrypted access credential. Source credentials are never rewritten or sent into task/verifier guests. The temporary archive key exists only in process memory; this is not a production crash-recovery or cloud-durability guarantee.

## Measurement correction

The runner originally summed normal step metrics. Native compaction updates cumulative usage events but does not emit a normal model metric. That undercounted tokens without reducing actual inference. Commit `9f434b6` fixes the guard and results to use cumulative usage events. Builder logic and prompts are unchanged. Session and WAL loaded the previous measurement code; their saved traces are audited with the same cumulative-usage rule. Later tasks load the corrected runner. Preserve the original result files rather than silently overwriting them.

Session's initially reported 369,586 tokens becomes **422,162**, including one compaction. WAL's final cumulative usage is **716,033**, including one compaction. Neither crossed the unchanged 4-million-token cap. These corrections invalidate the initial claim of slightly lower session token use.

## Results so far

| Task | Official reward | Agent seconds | Requests | Input | Output | Cached input | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| session-window-debug | 1 | 699.575 | 16 | 395351 | 26811 | 240640 | 422162 |
| wal-recovery-ordering | 1 | 928.495 | 20 | 682711 | 33322 | 495232 | 716033 |
| nextjs-performance | pending | — | — | — | — | — | — |
| bun-sourcemap-leak | not run: operator cancelled | — | 0 | — | — | — | — |

Private artifacts: `.ytimesy/terminal-bench-four-20261008/<task>-local-v2/`. They contain protocol, progress, trace, artifact export, original verifier execution/reward and exact owned-resource cleanup records. They must not be committed.

## Historical reference, not a fresh paired comparison

The [public native job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7) records Codex 0.159.0, GPT-6.1 Sol, Max, direct API credentials, five trials per task, Modal, and 64 concurrent trials. Its Fast setting is not public; off is an operator assumption. Effective resources and cache conditions are not fully matched. Its longer task allowance differs from this pilot's 30-minute cap. Source hash formats differ; this pilot does not independently establish byte-identical versions across the two runs. Subscription usage is not an API invoice.

Historical mean agent seconds / total tokens: session 541.4374 / 374445.2 (4/5 passes); WAL 601.4836 / 519873.4 (5/5); Next.js 2524.8072 / 5276946.8 (4/5). No Bun native reference has been verified here.

Our session attempt is 29.2% slower and uses 12.7% more total tokens than that session mean. It has 154,711 uncached input tokens versus the historical mean 49,888.6. WAL passed but is 54.4% slower and uses 37.7% more total tokens than its historical mean. These are directional comparisons of individual attempts against historical averages, not causal proof of harness inferiority/superiority.

## Trace observations

Session records 549.3 seconds in normal model requests and 32.7 summed tool seconds; WAL records 727.0 and 58.5 respectively. Model-request metrics exclude compaction time. Tool totals may overlap, so subtracting them from wall time does not precisely isolate overhead. Still, these traces do not support tool transport being the dominant delay. Compaction and uncached-prefix churn deserve investigation after this frozen pilot, rather than another blind transport optimization.

The inspected subscription adapter sets `workingContextTokens: 64_000`. `modelContextBudget` takes the minimum of this and the model's own compaction/input limits. This deliberately forces earlier compaction, independent of a larger available context window. It is a concrete follow-up candidate, not proof that raising it will improve latency or correctness. Do not change it during the frozen pilot.

The cumulative-minus-normal-metric usage difference is 48,170 input / 4,406 output / 3,456 cached input for session compaction, and 62,979 / 4,780 / 3,968 for WAL compaction. Cache reuse drops sharply on the first ordinary step after each compaction. Early tool discovery also changes the exposed schema; initial session steps have no cache reads. These observations motivate separately testing context thresholds and stable tool/guidance prefixes, not assuming either change guarantees a win. Public native compaction accounting completeness has not been independently audited.

## Verification and outstanding work

The accounting/transport regressions passed 33 targeted tests. Typecheck (including workflow types) and production build passed. The full suite and UI were not rerun for these evaluator-only changes.

Final grader results, remaining tasks, owned-resource inventory and final cost accounting are pending. Do not treat this document as a completed pilot until those sections are updated.

# Local builder Terminal-Bench pilot

Status: stopped after Next.js and its official grader, as directed by the operator. All three saved task snapshots passed; Next.js's model turn hit its deadline. This is not a benchmark superiority claim.

## Isolation and configuration

The operator approved a fresh $5 disposable Freestyle cap and existing Codex subscription. No API-paid fallback, production migration, Supabase storage request, or persistent machine is authorized by this pilot. The isolated `codex/builder-core-tools` checkout runs the builder only, without a leader, delegation, review or publication. The browser/UI and production queue are outside scope.

Four original task prompts, pinned task/verifier images and declared artifacts were planned in order: session-window-debug, wal-recovery-ordering, nextjs-performance, bun-sourcemap-leak. Each completed task gets one model attempt. The first three are familiar evaluation tasks, not unseen holdouts. Hidden tests run on a separate verifier VM and are never exposed to the builder. Passing these tests is not independent proof of general code quality.

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
| nextjs-performance | 1; model turn cancelled at deadline | 1799.122 | 61 | 2094113 | 56073 | 1470080 | 2150186 |
| bun-sourcemap-leak | not run: operator cancelled | — | 0 | — | — | — | — |

Private artifacts: `.ytimesy/terminal-bench-four-20261008/<task>-local-v2/`. They contain protocol, progress, trace, artifact export, original verifier execution/reward and exact owned-resource cleanup records. They must not be committed.

## Historical reference, not a fresh paired comparison

The [public native job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7) records Codex 0.159.0, GPT-6.1 Sol, Max, direct API credentials, five trials per task, Modal, and 64 concurrent trials. Its Fast setting is not public; off is an operator assumption. Effective resources and cache conditions are not fully matched. Its longer task allowance differs from this pilot's 30-minute cap. Source hash formats differ; this pilot does not independently establish byte-identical versions across the two runs. Subscription usage is not an API invoice.

Historical mean agent seconds / total tokens: session 541.4374 / 374445.2 (4/5 passes); WAL 601.4836 / 519873.4 (5/5); Next.js 2524.8072 / 5276946.8 (4/5). No Bun native reference has been verified here.

Our session attempt is 29.2% slower and uses 12.7% more total tokens than that session mean. It has 154,711 uncached input tokens versus the historical mean 49,888.6. WAL passed but is 54.4% slower and uses 37.7% more total tokens than its historical mean. These are directional comparisons of individual attempts against historical averages, not causal proof of harness inferiority/superiority.

Next.js's artifact passed at the 30-minute cutoff, with 59.3% fewer reported tokens than the historical mean. However, its turn was cancelled (`Model run cancelled.`), not naturally completed. Its 1,799.122 seconds is a deadline-censored run time, not a verified completed-run latency win against the public 2,524.8072-second mean. The interrupted request may have usage not reported by the provider. Next.js has 624,033 reported uncached input tokens, versus the public mean 190,444: about 3.28 times as many. Fewer total tokens alone therefore does not establish lower cost. No API-price equivalence or actual subscription quota cost is inferred.

## Trace observations

Session records 549.3 seconds in normal model requests and 32.7 summed tool seconds; WAL records 727.0 and 58.5 respectively. Model-request metrics exclude compaction time. Tool totals may overlap, so subtracting them from wall time does not precisely isolate overhead. Still, these traces do not support tool transport being the dominant delay. Compaction and uncached-prefix churn deserve investigation after this frozen pilot, rather than another blind transport optimization.

The inspected subscription adapter sets `workingContextTokens: 64_000`. All three saved traces report a model context window of 272,000 tokens. `modelContextBudget` takes the minimum of the working-context setting and the model's own compaction/input limits. This deliberately forces earlier compaction, independent of the larger available context window. It is a concrete follow-up candidate, not proof that raising it will improve latency or correctness. Do not change it during the frozen pilot.

The cumulative-minus-normal-metric usage difference is 48,170 input / 4,406 output / 3,456 cached input for session compaction, and 62,979 / 4,780 / 3,968 for WAL compaction. Cache reuse drops sharply on the first ordinary step after each compaction. Early tool discovery also changes the exposed schema; initial session steps have no cache reads. These observations motivate separately testing context thresholds and stable tool/guidance prefixes, not assuming either change guarantees a win. Public native compaction accounting completeness has not been independently audited.

Next.js records **five compaction starts, four usage-recorded completions**; the fifth was interrupted by the deadline. Completed compactions add 205,781 input / 21,923 output / 5,120 cached input tokens beyond ordinary model metrics. Normal model requests record 938.2 seconds and tools 231.1 summed seconds. Compaction lacks its own timing metric, so the remaining wall time cannot be precisely attributed. This run exposes context churn and finishing discipline as follow-up candidates; adding more retrieval tools is not supported as the primary solution by these traces.

## Verification and outstanding work

The final archive/accounting/transport regressions passed 34 targeted tests across four files. Typecheck (including workflow types) and production build passed after the accounting fix; ordinary TypeScript was rerun after the stop guard. The full suite and UI were not rerun for these evaluator-only changes.

All three official graders returned reward 1 and exit 0. Every valid task reports successful cleanup; local archive directories are empty and both builder/verifier resource registries are empty. A separate live Freestyle inventory query confirmed zero pilot VMs and snapshots. Docker reports no evaluation database containers. The exact Next.js anonymous database volume was ownership-verified and deleted after its container stopped; future database cleanup now uses `docker rm --volumes`. Previously detached anonymous Docker volumes were not broadly pruned because exact ownership cannot be reconstructed safely. Private traces, declared artifacts, protocols and original/audited results remain available locally.

Bun's output directory was never created: its queued process exited at the campaign stop guard, before resource allocation or inference. No further pilot runs were started. Earlier zero-inference attempts (Supabase quota preflight and the provider's five-minute execution limit) are preserved and excluded from model results. The quota attempt's remote cleanup could not be confirmed; it reported no successful new upload and started no VM. Existing remote archives were not deleted.

The approved disposable resource envelope remained bounded; no persistent hosting or API-paid model fallback was used. Actual billing/transfer charges were not fetched, so the $5 approval and resource-envelope estimate must not be presented as an audited invoice.

## Post-pilot context/cache fix

The frozen pilot above is unchanged. The follow-up removes the subscription
adapter's 64K implementation and 48K coordination overrides. Compaction now uses
the catalog's `auto_compact_token_limit`, bounded by the existing input safety
budget; absent a catalog threshold, the shared 80%-of-safe-input policy applies.
This does not send the entire advertised window without output/schema headroom.

Subscription and API adapters no longer retire consumed guidance, superseded reads
or earlier command output after each edit. Those history rewrites were permitted
even below context pressure and could invalidate cached prefixes. Keep exact
observations until actual compaction instead. Repository-context updates still
append fresh instructions and stale-source notices; write fences, archive/search
recovery, opaque native checkpoints and post-compaction instruction restoration
are unchanged. Deferred tool discovery remains enabled rather than loading every
specialist schema to chase cache hits.

Local regressions cover measured 70K retention on a 272K model, later compaction,
an explicit smaller provider threshold, exact instruction restoration, retained
OpenAI/OpenRouter output and opaque reasoning, and append-only source freshness.
No new live inference was run. Better cache hit rate, latency, cost and correctness
must be measured; this implementation is not proof of beating native Codex.

Validation: the regression reproduced premature compaction before the fix. After
the fix, 96 focused tests and the full suite passed (1,697 passed, seven skipped).
Typecheck including workflow types, Biome, production build and `git diff --check`
passed. No production deployment or Supabase operation was performed.

# Builder workflow performance rerun

One fresh live pair compared old ytimesy builder `d998928` with updated builder
`2668cbf`. This is not a native-Codex comparison or a general superiority claim.

## Matched conditions

GPT-6.1 Sol, low reasoning, Fast off; the same frozen TypeScript/Python pricing
refactor and protected 92-assertion grader. Both arms used the same disposable
2-vCPU / 4-GiB / 16-GiB VM and preinstalled dependencies. Control ran first.
Each arm retained ten requests and a 200-second model/tool deadline; the shared
persisted request cap was twenty. Reported elapsed time includes grading.

## Results

| Metric | Old builder | Updated builder |
| --- | ---: | ---: |
| Elapsed seconds | 35.551 | 38.650 |
| Provider requests | 8 | 8 |
| Input tokens | 116,045 | 95,263 |
| Output tokens | 776 | 891 |
| Total tokens | 116,821 | 96,154 |
| Cached input tokens (subset of input) | 75,392 | 79,360 |
| Protected grader | Pass | Pass |
| Final response | Completed | Completed |

The updated builder was **8.7% slower**, with **17.7% fewer total tokens**, than
the fresh control. Uncached input fell from 40,653 to 15,903 tokens (60.9%).
These token counts are not measured dollar charges or subscription quota costs.
Model time was 26.863 versus 28.536 seconds; tool time was 5.955 versus 7.436.

Compared with the preceding updated-builder run, elapsed time improved from
53.030 to 38.650 seconds (27.1%), total tokens from 145,109 to 96,154 (33.7%),
and requests from ten to eight. The previous run reached the step limit without
a final response; this run completed. Cross-run changes are descriptive, not
isolated causal estimates: provider timing varies, and today's control is still
faster.

## Trace observations

- The updated builder used ordinary exact edits and a shell file move rather
  than semantic rename tools. It read scoped repository guidance and retained
  required test and typecheck verification.
- Change inspection returned a compact 99%-similarity rename diff without
  pagination. Its call took 0.210 seconds, versus 7.090 in the preceding updated
  run. This does not identify the internal cause of that earlier slow RPC.
- The model did not use `compose_tools`; this pair therefore does not demonstrate
  the new composition path's speed or adoption.
- A shell search failed because the test VM lacked `rg` (exit 127). The model
  continued from already-read source and passed verification. Missing search
  tooling remains an environment gap; it was not silently counted as successful.
- Several exact-edit calls and additional scoped guidance reads remained in
  the updated path. The trace does not support claiming all remaining latency
  comes from any one of them.

## Evidence and boundaries

Private raw traces, patches and aggregate results are retained under the ignored
`.ytimesy/omp-builder-proof/a7d698f9-421e-485f-869a-f229d39ff464/` directory.
Sixteen of twenty authorized requests were used. The runner reported VM deletion;
an independent provider lookup subsequently returned HTTP 404. No persistent
compute, snapshot, publication or deployment was created.

This is one pair on a familiar development fixture, not an independent holdout.
Passing the protected grader supports correctness on this task, not universal
code quality. Queueing, leader/reviewer orchestration, database-journal durability,
browser tasks and durable-plan recovery were not measured. Native-Codex parity
and average performance across tasks remain unproven.

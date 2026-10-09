# Native Codex versus our builder: inspected public trajectories

Date: 2026-10-08. Research only; no inference, resources, application changes or
deployment. This familiar task is not a holdout. Public agent trajectories were
inspected, not hidden verifier code or canonical solutions. Do not inject their
task-specific fixes into future evaluation prompts.

## Evidence

- [Public job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7): Terminal-Bench 4.0.0, Codex 0.159.0, GPT-6.1 Sol, Max.
- [Fastest passing trajectory](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/524fbff7-08a1-5003-9f33-335374dbd2ae): reward 1, 448.128 agent seconds.
- [Second passing trajectory](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7/trials/ec4e0b0c-4296-53bf-b93d-986936644cea): reward 1, 575.298 agent seconds.
- Our frozen `de119b6` run: private `session-window-debug-rerun/trace.json`
  under `.ytimesy/terminal-bench-trace-fix-20261008/`; reward 1,
  696.315 agent seconds. [Existing report](builder-terminal-bench-local-pilot-2026-10-08.md).

Agent-browser loaded both public trial pages and their trajectory tabs. Its
observed network requests exposed the public `/api/trials/<id>/trajectory`
response, ATIF-v1.7, including step timestamps, tool arguments/results and
per-step usage. No authentication bypass was required. The 16 displayed steps
include three setup/system/user steps: each inspected native trajectory actually
contains 13 agent model calls, not 16 requests. Neither shows child delegation.

## Observed execution differences

| Measure | Native fastest | Native second sample | Our latest builder |
| --- | ---: | ---: | ---: |
| Agent seconds | 448.128 | 575.298 | 696.315 |
| Model requests | 13 | 13 | 10 |
| Input plus output tokens | 390719 | 379121 | 267080 |
| Uncached input tokens | 46454 | 50600 | 62111 |
| Output tokens | 24092 | 29088 | 21673 |
| Protected reward | 1 | 1 | 1 |

The two native samples are illustrative, not a replacement for all five trials.
The previously verified five-trial mean is 541.4374 agent seconds and 374445.2
tokens, with four passing trials. Our single latest run is 28.6% slower than that
mean while using 28.7% fewer total tokens and 24.5% more uncached input. This is
not a matched fresh control, statistical superiority test or actual cost audit.

### Earlier feedback, not fewer calls

In the fastest public trajectory, step 8 executes small baseline reproductions
at 84.593 seconds from the first system step. Its successful patch is step 11 at
277.552 seconds. The second sample executes baseline reproductions at 105.855
seconds and its first substantive successful patch at 278.114 seconds. These are
trajectory timestamps, not independently measured inference durations; command
completion occurs just afterward.

Our first two requests are short, but request 3 lasts 306.393 seconds and request
4 lasts 179.447 seconds. Before running its first baseline tests, it generates
a persistent regression file with approximately 15,582 patch characters.
Together those two calls take 485.840 seconds, about 70% of the whole agent run.
The model waits 201.518 seconds before first output in request 3 and 87.924 in
request 4. These waits can include reasoning and provider-side service latency;
they are not proof of CPU, network transport or harness overhead alone.

The native workflow reaches executable evidence earlier and grows its checks
after a working patch. Our workflow delays evidence while preparing a larger
test artifact. This supports investigating incremental diagnostic feedback,
not forcing fewer model calls, reducing reasoning quality or skipping tests.

### Native verification is substantial

The fastest trajectory runs inline unittest regressions, randomized histories,
syntax validation and protected-file checksums. The observed results and final
summary report 22 tests and 61,500 randomized events. The second runs 21 tests
followed by five lifecycle tests, with randomized histories in both batches.
Neither persists a new test file in its final workspace inventory.

Our run persists 18 regressions, checks source changes and read-only constraints,
and passes the protected grader. Persistent tests are useful deliverables;
native temporary tests are not automatically better code quality. Native is not
faster merely because it does no verification. Test counts and generated checks
alone do not establish quality superiority for either implementation.

### Cache continuity differs

Both native trajectories start with approximately 12K input tokens, then report
cached input on every later model call. The previous native prefix is reused as
history grows. Our initial input is smaller, approximately 3.6K tokens. At
request 4, deferred discovery expands active tools from 16 to 21 and prepared
tool text from 14,711 to 21,525 characters; all 18,293 input tokens are uncached.
Later caching resumes. This is an observed schema-change/cache-miss association,
not an isolated causal experiment proving a specific latency reduction.

Preloading every specialist would enlarge all prompts. The actionable candidate
is a small stable everyday builder tool set, including the edit capability it
will predictably need, while retaining deferred loading for specialists.
Investigate actual schema order, provider caching behavior and supported patch
capabilities before changing the prompt. Do not disable tools, safety or context
recovery just to inflate the cache percentage.

### Native has imperfections too

The fastest native trace rereads source after output truncation, searches for a
missing patch executable, gets a failed empty-patch invocation and rejects a
misquoted real patch before succeeding. The second also searches for patch
helpers. Its command interface is mostly `exec_command`, with `write_stdin` for
a running command in the fastest sample. No specialized index, LSP, memory
retrieval, browser or swarm is invoked in these two trajectories.

Our recent changes already removed full-source reread and cosmetic-format loops.
Our remaining unsupported batch-verification attempt was fixed in descriptions
after the measured run; that fix has only local regression verification so far.
These traces do not support adding more specialist tools as the primary answer.

## What this establishes, and what it does not

The strongest observed gap is **time to useful execution feedback**, dominated
in our sample by long analysis/test-generation requests. Native produces more
output tokens and more requests yet finishes sooner. Therefore total tokens,
request count and tool execution speed alone cannot explain the result.

Our recorded model durations sum to 668.8 seconds; tool durations sum to 38.6
seconds and can overlap. Public step deltas include command and model time and
do not expose comparable request-start/first-output telemetry. Native uses direct
API credentials, while ours uses the subscription transport. Fast/service-tier
is not exposed in the inspected native configuration. Matching the public model
name and Max setting does not prove identical serving throughput.

Before claiming a causal harness advantage, record reasoning-token usage and
provider request/first-output timing separately from tool time, then compare
held-fixed transport conditions. The immediate hypothesis is earlier small
reproductions and coherent edit/check feedback, plus eliminating predictable
schema churn—not a guarantee that a new instruction will beat Codex. Do not
copy the task solution or sacrifice durable regression coverage to chase time.

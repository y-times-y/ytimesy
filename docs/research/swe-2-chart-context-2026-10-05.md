# SWE-2 chart: source and interpretation

Checked 2026-10-05 against primary sources, including the live Cognition page in an isolated agent-browser session. This is source verification, not an independent benchmark run.

## What Cognition reports

The September 10 release table matches the supplied numbers: SWE-2 gets **50.0% on FrontierCode 1.1 Main, 73.0% on DeepSWE 1.1, and 92.8% on Terminal-Bench 2.1**. [SWE-2 release](https://cognition.com/blog/swe-2)

SWE-2 is post-trained from Kimi K3. Cognition describes reinforcement learning across effort levels, cost penalties, training data improvements, and serving changes. This is evidence of model training work; the chart does not establish that harness engineering caused the improvement. Appendix A mixes existing public results with internal evaluations in provider-specific harnesses: Claude Code, Codex, Grok Build, and Devin CLI. It selects the best score across effort settings. This is not a controlled same-model harness comparison. [Release and Appendix A](https://cognition.com/blog/swe-2)

The chart labels cost as mean USD spend per rollout, using list pricing including public discounts. It does not measure task completion time. The training reward's cost term separately mixes inference dollars and rollout time. The bar table and cost curves can select different effort settings; a maximum score need not describe the cheapest plotted point. [Release, live chart labels, and methodology](https://cognition.com/blog/swe-2)

## What the benchmarks measure

**FrontierCode:** 50.0% is a weighted rubric score, not a binary task pass rate. Passing requires all blocking criteria; failed blockers yield zero, while passing runs receive a weighted aggregate of rubric items. The grading includes correctness, regression safety, mechanical cleanliness, test correctness, scope, and code quality, using tests, commands, and LLM-assisted criteria. [Original methodology](https://cognition.com/blog/frontier-code)

Main is the 100 harder tasks from a 150-task set. Revision 1.1 permits legitimate documentation lookup but detects solution-bearing internet use and zeroes flagged runs; it also demotes 75 overly strict blockers. Results need the exact revision and score/pass-rate label. [Revision 1.1](https://cognition.com/blog/frontier-code-1.1)

**DeepSWE 1.1:** retains the long-horizon tasks while evaluating only the agent's committed patch in a fresh verifier container. Structured per-test reports expose missing or failed tests; future Git history is removed. The owner stopped reporting wall time because host performance and provider load make it inconsistent. [Datacurve methodology](https://deepswe.datacurve.ai/blog/deepswe-v1-1)

**Terminal-Bench 2.1:** is a revision of 89 terminal tasks. The announcement describes repairs to 28 tasks involving dependency drift, resource mismatches, and misspecification. Its repository README instead says 26 tasks changed, so those owner texts have a count discrepancy. Official submission instructions require at least five trials per task and public uploads; they do not establish that Cognition's release-table result followed that submission protocol. [Owner announcement](https://www.tbench.ai/news/terminal-bench-2-1), [owner repository](https://github.com/harbor-framework/terminal-bench-2-1)

## Limits for ytimesy

These sources establish reported benchmark results and disclosed methodology. They establish neither ytimesy's score nor a transferable advantage from changing its harness. They do not disclose a complete private competitor architecture. To measure a ytimesy harness effect, compare the same model and effort on paired tasks with declared budgets, grading, retries, total inference cost, and end-to-end wall time.

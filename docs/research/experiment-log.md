# Experiment log

One line per harness hypothesis that was tested: date, what, result, where the
details are. Search this file before proposing or running a test; add a line
after every test, including small ones and ones that failed.

| Date | Hypothesis | Result | Details |
|---|---|---|---|
| 2026-10-18 | Code mode `on` vs off (Sol, 5 small tasks x 3) | No gain: same steps, +20% input (tool description) | Session notes; `docs/hard-set.md` |
| 2026-10-19 | Code mode `on` on hard tasks | Model called `run_code` 0 times; led to `codeMode=primary` | Commit 5ca3e83 |
| 2026-10-24 | Code mode off vs `on` vs `primary` (heat-pump-warranty, subscription) | `primary` best: $0.55 / 20k out / 8.8 min vs `on` $0.69 / 21k, off $0.71 / 24k; Codex avg $0.69 / 20k | Became the base variant (f50630c) |
| 2026-10-24 | Code mode off vs `primary` (session-window-debug, subscription) | Even: off $0.29 / 21k out vs `primary` $0.31 / 24k; both pass. `primary` saves on read-heavy tasks, neutral on short fix tasks; 1 of 28 programs failed | Session notes |
| 2026-10-24 | Checker (review loop) on TB4 | Stopped for TB4 | `checker-learnings-2026-10-24.md` |
| 2026-10-22 | Fusion lead (Sol + Luna) | 2x cost, 4x time, 4/15 vs 8.8; dropped for TB4 | Session notes |
| 2026-10-25 | grind, effortMix, envSnapshot, ledger, goal | None beat base on held-out tasks; all off by default | `harness-switches-2026-10-25.md` |
| 2026-10-25 | TB4 untouched 25-task subset, base | 14/25, identical to Codex; +7% cost at list price, all from output | `harness-switches-2026-10-25.md` |
| 2026-10-26 | Tool-result format: decode `run_code` results to plain text | The JSON seen in traces is a trace artifact; the model already gets text. Real escaping cost is 3% of `run_code` results | Not shipped |
| 2026-10-26 | Trim `run_code` call log (no output preview on completed calls) | -11.7% `run_code` results, about -2% total input; reverted: a failing bash exit counts as completed, so its only output preview would be lost | Not shipped |
| 2026-10-26 | Code mode `on` vs `primary` again (shadow-relay, mvcc-lsm-compaction, subscription) | Repeat of 2026-10-24, same answer: `primary` 12.2k / 13.0k out vs `on` 17.0k / 15.1k; both below Codex medians | Should not have been rerun |
| 2026-10-26 | Astra xhigh, our harness with plan/helpers/fetch on, vs Reason and Codex (subscription, 4 dev tasks x1) | mvcc pass $0.92 (Reason $0.84, Codex $1.66); shadow-relay pass $2.28 (builder $1.45 + helper $0.82; Reason $1.11, Codex $1.42); heat-pump and wal invalid (subscription usage limit). Helpers add cost on short tasks | scratchpad astra/; Bedrock rerun pending |
| 2026-10-26 | Astra xhigh on Bedrock, plan/helpers/fetch on (shadow-relay) | Before helper fix: pass $3.04 (helper $1.33, waited on it after solving). After 483cda8 (bridge helper section, 10-min cost bar): pass $1.59, 0 helpers, 4.5 min; still above Reason $1.11 / Codex $1.42: builder output 13.5k vs Reason 6.5-9.4k (tool code ~6.1k vs 3.5-4.5k, thinking ~7.4k vs 3-5k) | scratchpad astrab/, astrac/ |
| 2026-10-26 | Astra xhigh shadow-relay: prompt=minimal (rule blocks removed) | Pass, $1.88: thinking 4.9k -> 3.8k but tool code 6.1k -> 10.0k (o200k counts); worse overall. Two full-prompt runs differ by 2.3k output, so one trial per arm cannot resolve 20-30% | scratchpad astrae/ |
| 2026-10-26 | Decoded Reason vs ours on shadow-relay (no new runs) | Same tools; difference is use: Reason 5-9 direct bash + 3-4 small codemode, ours 9 run_code (primary). Ruled out: reasoning summary (detailed vs auto vs none, replay), reasoning passback (works on Bedrock), run_code escaping (5-7%). Parity setting is now codeMode=on (docs/harbor-bridge-v2.md); not yet measured on Astra | scratchpad astra/tok.py, esc.py |
| 2026-10-26 | Reason parity setup codeMode=on,plan,helpers,fetch on Astra xhigh (shadow-relay x3, Bedrock) | 3/3 pass; output 9.1k/10.6k/12.4k (median 10.6k) vs Reason 6.6k/7.4k/9.4k; thinking median 4.1k vs 1.7k, code 6.2k vs 5.6k; $1.40-1.99. Direct bash use did not close the gap: thinking still ~2.5x. Plan tool used 3-4x per run (Reason 0 on this task); 15-18 requests vs Reason 11-16. Cause of the thinking gap still unknown | scratchpad astraf/ |
| 2026-10-26 | Bedrock vs OpenAI API, same Astra xhigh requests (shadow-relay states 7 and 10, 3 reps each, replay) | Same: reasoning tokens step 7 OpenAI 387/516/514 vs Bedrock 516/516/516; step 10 OpenAI 1469/1274/1034 vs Bedrock 1530/1034/1034. Route is not the thinking gap. Replay (no earlier reasoning passed back) step 10 output 2.8-3.7k vs the live run's 4.4k | scratchpad astra/route-*.jsonl; OpenAI $1.32, Bedrock $1.50 |

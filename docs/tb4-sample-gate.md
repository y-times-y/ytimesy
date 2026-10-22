# TB4 paired sample: pre-registered gate (2026-10-21)

Written before any sample trial ran. It decides go/no-go for one trial of every TB4 CPU
task with our newest harness. Runner: `scripts/tb4-sample/` (`sample.sh`, `analyze.py`).

## What runs

- 12 CPU tasks, 1 trial each, in parallel on one m7i.16xlarge (us-east-1), Harbor 0.24.0,
  `-e docker`, full agent timeouts (multiplier 1.0, every task 28 800 s), no Harbor retries.
- Harness at a frozen commit (given at run time; it must contain `evals/harbor_v2`):
  route bedrock, model `openai.gpt-6.1-sol`, effort max, variant
  `lead=fusion,review=on,checkerMode=single,rigor=on,codeMode=primary,roleModels.checker=bedrock:openai.gpt-6.1-sol,roleModels.writer=bedrock:openai.gpt-6-luna,roleModels.classifier=bedrock:openai.gpt-6-luna@low`.
- Caps: $8 per trial (bridge), $40 for the sample (spend watcher, see Spend), request limit 1000
  per trial so the dollar cap, not the request count, is what binds.
- Every task passed the 2026-10-21 oracle/nop preflight (tb4-preflight 77e1b5c).

## Comparison data

Codex CLI + GPT-6.1 Sol, reasoning effort max: the public Harbor job, 330 trials (66 tasks x 5),
192 passed (58.2%; 58.7% without its 3 errored trials; public figure 58.6%). Per-task table:
`scripts/tb4-sample/codex-pertask.json` (also our frozen v13 per-task passes).

## Selection rule (mechanical)

From the 63 CPU tasks drop cad-model and vpp-loss-divergence (failed preflight),
retro-console-soc (load-sensitive oracle) and tasks whose Codex or v13 median wall time
exceeds 90 min. In each Codex bucket take the shortest tasks by Codex median:

| Codex | Tasks |
|---|---|
| 5/5 | shadow-relay, mvcc-lsm-compaction, heat-pump-warranty |
| 4/5 | session-window-debug, payments-pipeline-fix |
| 3/5 | interleaved-vigenere, vf2-speedup-networkx |
| 2/5 | freecad-spring-clip, batched-eval-parity |
| 1/5 | atrx-vep-crispr, protein-autointerp-disulfide |
| 0/5 | roy-polymorph-cn |

Codex expected passes E = 7.0 of 12 (58.3%). Our v13 harness's expected passes on the
same tasks: 5.8. Host CPU budget: sum(cpus + 1) = 50 <= 62.

## Gate (all must hold for GO)

- **G1 clean.** All 12 trials valid: a verifier reward, no Harbor exception, no bridge
  `failure`, no refusal, no cap or request-limit stop, a trace with cost, and a fingerprint
  matching the commit, model, effort, variant and role models above. An infra failure
  (image pull/build, Docker, environment start or agent setup timeout, host fault) may be
  rerun once per task, at most 2 reruns in the sample. Any harness error, or the $40 stop
  firing, is NO-GO: fix it and rerun the sample.
- **G2 score.** Our passes >= 8 (Codex's expected passes on the sample, 7.0, plus one).
- **G3 no harness-caused regression.** Every failure on a Codex 5/5 task gets a one-line cause
  from its trajectory before the verdict. If any is harness-caused (stopped early with budget
  left, checker or review loop, tool or transport failure), NO-GO whatever the score.
- **G4 cost.** Mean model cost per trial <= $3; above that, HOLD and re-plan the full run's caps.

`analyze.py` prints G1, G2, G4 and the G3 list mechanically; G3 labels are the only judgment.

GO means: run every CPU task that passes preflight (61 of 63; cad-model and
vpp-loss-divergence excluded) once, same commit and settings.

## Why 8 (E + 1), not 7

Set to 8 on 2026-10-21 before any run. The user's condition for the full run is confidence that we beat Codex, not parity: at 7 a harness equal to Codex gets GO 65% of the time; at 8, 35%, and a v13-like harness 4%. The cost is that a harness at our target (+5.8 points) is held back 40% of the time; a held-back run is reported, not lost. The analysis below was written for 7 and is kept for the record.

## Original reasoning for 7

Passes on 12 tasks are a sum of Bernoulli trials. Under Codex's own per-task rates the sd is
1.26 passes. Probability of meeting each threshold (a logit shift of the per-task rates; shift
+0.5 is about +5.8 points over all CPU tasks, our target is +5):

| True harness | E | P(>= 7) | P(>= 8) |
|---|---|---|---|
| v13-like (per-task v13 rates) | 5.8 | 0.26 | 0.04 |
| 12.7 points below Codex | 4.8 | 0.11 | 0.03 |
| 6.2 points below Codex | 5.8 | 0.31 | 0.12 |
| equal to Codex | 7.0 | 0.65 | 0.35 |
| 5.8 points above Codex | 7.8 | 0.83 | 0.60 |
| 11.5 points above Codex | 8.7 | 0.95 | 0.83 |

With 8, a harness that would reach our target fails the gate 40% of the time. A false GO costs
one full run (about $100 to $130 of Bedrock plus EC2); a false NO-GO costs a delay and another
sample. 7 blocks a v13-like or clearly worse harness most of the time and passes a target-level
one 83% of the time.

## Weaknesses (stated before the run)

- 12 trials cannot separate harnesses within about 10 points: the gate catches bugs and large
  regressions, not a 2 to 5 point gap. Passing it is not evidence that we beat Codex.
- A v13-level harness still passes about 1 time in 4.
- The rule favors short tasks; harness differences in our gap analysis (premature stop, weak
  verification) may show more on long tasks. On this sample v13's expectation (5.8) is further
  below Codex (7.0) than over the whole benchmark, so the sample may understate us.
- Codex's rates are 5-trial estimates (each +-0.2); E carries that error too.
- One run, one host, one day of Bedrock latency; Codex ran on Modal.
- G3 needs a human (or agent) label per failure.

## Spend

The bridge ledger reserves each trial's whole cap before it starts, so 12 parallel trials at
$8 need a ledger total of $96 to start at all. The ledger total is set to 12 x $8 = $96 (hard
worst case), and `spendwatch.py` on the host enforces the sample's $40: every 60 s it sums each
trial's live spend from the bridge logs and, at $40, writes the ledger stop file, stops this
run's Harbor jobs and bridges, and marks the run ABORTED (G1 fails). Expected spend: $14 to $20.

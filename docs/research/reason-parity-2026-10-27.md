# Reason Agent cost parity on GPT-6 Astra (2026-10-26/27)

Setup: `YTIMESY_HARBOR_VARIANT=codeMode=on,plan=on,helpers=on,fetch=on`, web search on, GPT-6 Astra
at xhigh, commit c658db5 (`update_plan` never a step on its own). Reason and Codex figures are
their public Harbor Hub trials (Reason 3 per task, Codex job caf6e433 5 per task, both xhigh on
OpenAI's API). All costs are at OpenAI's own billing: list price, cache writes billed as plain
input (the formula Codex's published costs use, 0.0% median error on 200 trials; Reason's
published costs bill uncached input as cache writes and were recomputed).

## Panel (6 dev-split tasks, 3 runs each)

| Task | Ours: pass, median (runs) | Reason | Codex |
|---|---|---|---|
| shadow-relay | 3/3, $0.95 (0.89, 0.95, 1.51) | 3/3, $1.01 | 5/5, $1.42 |
| mvcc-lsm-compaction | 3/3, $0.81 (0.71, 0.81, 0.84) | 3/3, $0.78 | 4/5, $1.66 |
| wal-recovery-ordering | 3/3, $1.15 (1.09, 1.15, 1.72) | 3/3, $1.25 | 5/5, $2.15 |
| heat-pump-warranty (OpenAI API) | 3/3, $2.83 (2.75, 2.83, 3.08) | 3/3, $2.96 | 5/5, $6.55 |
| interleaved-vigenere | 3/3, $1.63 (1.41, 1.63, 2.21) | 3/3, $1.66 | 5/5, $2.51 |
| session-window-debug | 2/3, $1.18 (1.14, 1.18, 1.41) | 2/3, $1.39 | 2/5, $1.67 |
| Total of medians | 17/18, $8.55 | 17/18, $9.05 | $15.95 |

Below Reason on 5 of 6 tasks and 5.5% in total, no task with fewer passes; 46% below Codex.
Single runs vary about +-25%, so the 5.5% lead over Reason is within run-to-run noise at 3 runs per
task; the lead over Codex is not.

## What closed the gap (each measured on shadow-relay, o200k token counts)

1. Helpers: the bridge gave the builder the product's writer-delegation text; it started a
   researcher on a 5-minute task and waited for it. Own helper section with a cost bar:
   $3.04 -> $1.59 (Bedrock).
2. Check in proportion (unattended runs): output 13.5k -> 11.2k.
3. update_plan alone in a step: 3-4 plan-only requests per run, 13-20% of cost. Description now
   says never alone and only for ~20+ step work: plan-only steps 0, median $1.37 -> $0.95.

## Ruled out (measured)

Reasoning summary setting (detailed/auto/none, replay), reasoning passback (works on Bedrock),
run_code escaping (5-7% of code tokens), Bedrock vs OpenAI API on text requests (same reasoning
tokens), prompt rule blocks (prompt=minimal: thinking -1k, code +4k), tool-use style alone
(codeMode=on vs primary: thinking 4.1k vs 4.9k).

## Bedrock and images

Same requests on both routes (Astra, image tool results): OpenAI caches them; Bedrock serves 0
cache hits to any request that adds an image and counts an image at ~600 tokens vs OpenAI's ~190.
heat-pump-warranty on Bedrock cost $4.75 per run and two runs hit the $6 trial cap; on OpenAI's
API the same setup cost $2.83 with 89-92% cached. Image-heavy tasks must be compared on OpenAI's
API; the bridge now leaves `openaiDirectUsd` null for Bedrock trials that read images (db96554).

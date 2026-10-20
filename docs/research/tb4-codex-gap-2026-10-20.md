# TB4: why Codex CLI beats our harness with the same model (2026-10-20)

Offline comparison of our TB4 trials (frozen harness v13, GPT-6.1 Sol) against the public Codex CLI job on the same tasks. No model runs. Working notes, per-task data and scripts: `/Users/user/.claude/jobs/71b49d05/tmp/analysis/` (local, not committed).

## Measured

- Same 64 tasks: ours 55.5% pass@1, Codex 58.0%: a 2.4-point gap (95% CI -1.3 to +6.1). The headline 54.5 vs 58.6 counted fp8 and jax for Codex only; our fp8 trials ran on an RTX PRO 6000, not an H100 (infra, not harness).
- Time and tool use are similar: median 23 min / 33 tool calls per trial (ours) vs 20 / 35 (Codex).
- Neither agent writes a requirements checklist (1 of 329 Codex trials mentions one).
- Our agent states an assumption and carries on ("assume", "treat as", "I'll treat … literally") in 47 of 321 trials; Codex in 13 of 329.
- We compact in 28% of trials vs 18% for Codex; our tool output chunks reach 33k characters vs about 10k. After a compaction our agent re-dumps the workspace 62% of the time. Pass rates with and without compaction are the same for both agents; no failure is proven to come from compaction.
- Failure relabel of our 99 failed trials: weak verification 34, spec misread 20 (about 25 counting math-eval), premature stop 17, no grader output 16, environment 7, capability 5.

## Differences that cost us trials (1 trial = 0.31 pass@1 points; estimates)

1. Ambiguity resolved our own way instead of by the ecosystem convention or the strictest reading with margin: 13 lost trials, est. +1.2 to 2.4 points.
2. Stopping with an admitted unverified risk and most of the time budget unused: 9 lost trials, est. +0.9 to 1.5.
3. Never running the deliverable the way an outside grader would (bundled data files, undeclared dependencies, checking through our own layer instead of a plain client): 4 to 6 lost trials, est. +0.6 to 1.5.
4. Web search: about 0.

These overlap: combined est. +2 to 5 points of pass@1, unmeasured end to end. Per-task samples are 5 trials, so uncertainty is high.

## Conclusions

- A literal requirements checklist is worth little (est. +0.3 to 0.6): Codex makes the same misreads. Checking the agent's own stated assumptions is worth more.
- Changes must stay general (this analysis read test-split grader output): check stated assumptions against convention and the strictest reading; do not accept "done" while admitted gaps remain and budget is left; run the deliverable as an outside user would; cap tool output near 10k characters.
- Being built behind harness variants on branch `tb4-behaviours` (to be measured on the hard set before becoming default).

## Related findings the same day

- Best-of-K stays shelved: TB4 failures repeat across runs; a checker-gated second attempt is est. +2.3 points at about 1.6x builder cost.
- Child agents (checker, reviewer, subagents) did not inherit the builder's reasoning effort; they ran at the route default.
- Prompt cache hit rate on the Codex subscription: median 88% per run, 91.5% token-weighted; the misses are new content, not broken prefixes.
- Web search is already on in the product (Codex subscription, official APIs, OpenRouter) and in Harbor bridge v2. Remaining tool gaps vs Codex CLI: no stdin/PTY for interactive commands, no `update_plan`.
- Live subagent delegation: across 12 live runs with `subagents=on`, Sol never called `agent`; tasks finished in 5 to 7 minutes, which our delegation guidance says not to split.

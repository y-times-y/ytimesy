# TB4 scoring rule (next full run: Sol in our harness vs public Codex + Sol)

Fixed before the first scored trial. Based on the rule disclosed for the 2026-10-12 run and
the 2026-10-13 rerun amendment (`benchmarks/evaluation/tb4-rerun-20261013.md`). Changes are
dated amendments at the end of this file, committed before the trials they affect. The
controller implements it in `scripts/tb4-run/lib.ts` (`classify`, `scoredTrials`,
`passAt1`, `pairedComparison`, `batch2Decision`), tested in `tests/tb4-run.test.ts`.

## 1. What runs

- Terminal-Bench 4.0 (`terminal-bench/terminal-bench@4.0.0`), all 66 tasks, pinned task
  images, Harbor 0.24.0, Harbor's local `docker` environment on our AWS hosts.
- Harness: bridge v2 (`evals.harbor_v2.agent:YtimesyHarborV2Agent`), route `bedrock`,
  variant `lead=fusion,review=on,checkerMode=single,rigor=on`. Sol
  (`openai.gpt-6.1-sol`, max effort) is the lead and the checker judge; Luna
  (`openai.gpt-6-luna`) is the sidekick, checker worker and classifier. One writer.
- One frozen commit and bridge bundle for the whole run: the commit and the bundle's
  SHA-256 are journaled at `init` and recorded in every trial's trace.
- Providers: CPU tasks on EC2 `m7i.16xlarge` Docker hosts; the 3 GPU tasks
  (`fp8-rmsnorm-gemm`, `jax-speedrun-gpu`, `math-eval-grader`) on one EC2 `p5.4xlarge`
  (1 H100), us-east-1.

## 2. Valid vs infra

A trial is **valid** when the agent started, a reward was recorded, the agent's `/app`
reached the grader, the GPU (GPU tasks) was asserted as an NVIDIA H100 inside the trial
before the agent started, and no provider cut that the transport guard could not recover
ended the agent. Ordinary outcomes are always valid: wrong answer, gave up, agent time
limit, refusal, a bad command that broke the container.

Everything else is **infra**: rerun, never scored.

- the agent never started;
- the grading environment failed to build, or the grader produced no reward;
- the host was killed, rebooted or lost (EC2 retirement, OOM-killed host, network loss
  long enough that the Harbor process died);
- the workspace did not reach the grader;
- a model transport failure (stream cut, connection reset, outage, Bedrock throttling)
  that the guard could not recover ended the agent;
- a GPU task where the H100 assertion failed or is missing.

**Graded trials are never rerun.** A valid trial's result stands whatever it is.

## 3. Attempt caps

Per task per batch: CPU tasks at most `trials + 3` attempts, GPU tasks `trials + 4`
(batch 1: 4 / 5; batch 2: 7 / 8). A task that reaches its cap with fewer valid trials is
reported with the valid trials it has and the infra reasons, and is not padded with zeros.
If more than 5% of tasks hit the cap, the run is reported as incomplete.

## 4. Batches and which trials count

- **Batch 1**: 1 trial per task. **Batch 2**: 4 more per task on the same frozen commit.
- If more valid trials exist than a batch needs (a trial thought lost was later found
  graded), the batch's first valid trials **by agent start time** count; the rest are
  disclosed, not scored. Batch 1 contributes its first 1, batch 2 its first 4: 5 per task.
- **Batch 2 goes ahead** only if, after every task has its batch-1 trial, the paired
  per-task mean difference vs Codex (section 6) is **at least +3 points**. Otherwise the
  run stops and batch 1 is published as a 1-trial result. Batch 1 is reported either
  way; it is never dropped or rerun because of its score. Opening batch 2 against this
  rule needs a dated amendment.

## 5. pass@1

pass@1 = mean over the 66 tasks of (passes / scored trials), a pass being reward >= 1,
the same per-task mean as the public Codex job's 58.6%. We also report trial-level
passes/trials and unbiased pass@k (Chen et al. 2021, `passAtK`) for k = 1..5 after batch 2.

## 6. Paired comparison with the public Codex job

Codex CLI + GPT-6.1 Sol max, Harbor job `299f37fe-9a7f-51f4-9619-af26e8312fd7`, per-task
passes/trials in `benchmarks/evaluation/codex-public-job.json`. For each task
d = our pass rate - Codex's pass rate; we report mean d (points), a seeded paired
bootstrap 95% interval over tasks (10 000 draws, seed 20261021), and the counts of tasks
better / worse / tied. "We beat Codex" is claimed only when the 95% interval is above 0
after batch 2; otherwise we say "ahead by X points, not significant".

## 7. Budget stop

- Models: bridge per-trial cap $12, total ledger cap $900 per host, and the controller's
  global stop at $900 settled across all hosts (expected $360-500 for 330 trials).
- AWS: monthly account budget $1500 with email alerts at 50/80/100% (EC2 + Bedrock +
  Marketplace). Infra expected $300-560.
- At a stop no new trial starts; running trials finish and are scored. Tasks left without
  5 valid trials are reported as incomplete with the reason "budget stop".

## 8. What we disclose

The frozen commit and bundle SHA-256; models, efforts and roles; AWS instance types and
region; every infra attempt with its reason; extra valid trials not scored; tasks at the
attempt cap; total model and infra cost and cost per trial; the batch-2 decision with its
numbers; that Codex's job ran on Harbor's hosted infra while ours ran on EC2 Docker hosts;
that Bedrock has no hosted web search (Codex's job had none either if its config confirms,
else we say so); and any amendment.

## Amendments

None.

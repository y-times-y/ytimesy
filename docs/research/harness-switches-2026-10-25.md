# Harness switches tested 2026-10-25

Five new harness switches, each tested against the base harness with the same model, plus a frozen check on untouched TB4 tasks against Codex.

**Bottom line:** no switch beat the base harness on tasks we had not looked at. All five are merged to main (f50e45b) and **off by default**. Goal mode is kept for the product. On 25 untouched TB4 tasks, the frozen base harness matched Codex task for task (14/25 each) at about 20% higher cost.

## Setup

- **Model:** GPT-6.1 Sol, effort max, on the Bedrock route (`openai.gpt-6.1-sol`). The early arms ran on the Codex subscription until it hit its usage limit; trials that hit the limit were discarded and rerun on Bedrock.
- **Base harness:** `lead=off,review=off,rigor=off,codeMode=primary`.
- **Benchmark for development:** Terminal-Bench 2.1. TB4 was not used for tuning.
- **Cost:** all figures use OpenAI list prices (`model-pricing.ts` maps Bedrock ids to `openai/gpt-6.1-sol`), so they compare directly with Codex. The bridge's `usage ... usd=` log line is a running total per trial: take the last or highest value, never sum the lines.
- **Spend:** about $123 on TB 2.1 and $30.70 on the TB4 subset.

### Why only hard tasks

TB 2.1 is saturated: the base harness passes about 87% with Sol. A switch can only show an effect on tasks the base fails, so every arm ran on a hard set of tasks the base failed with a genuine grader failure:

- build-cython-ext
- configure-git-webserver
- extract-elf
- kv-store-grpc
- mteb-retrieve
- video-processing

**Lesson:** one base trial per task is too noisy to pick hard tasks. portfolio-optimization and raman-fitting each failed once but pass about 75% of the time. Use public per-task data, or several base trials, before choosing a hard set.

## Results

Counts are passes over trials, summed over the six hard tasks. Base on the same tasks was 8/36 (22%).

| Switch | Hypothesis | Result | Cost | Verdict |
|---|---|---|---|---|
| `grind` | The agent stops early; sending it back to try to break its own result finds bugs | 5/6 vs base 5/6 on one-hour tasks | 1.6x ($2.49 vs $1.59 per trial) | Dropped |
| `effortMix` | Max effort for planning, high for the rest: same quality, cheaper | 1/12 vs base 2/12 (same batch) | lower | Dropped: worse |
| `envSnapshot` | Giving the agent the environment's facts up front prevents wrong assumptions | 4/12 | about the same | Flat (within noise of base 22%); off |
| `goal` | A Codex-style goal loop with an evidence audit stops premature finishing | 3/12 | higher | Flat; off for benchmarks, kept for the product |
| `ledger` | Writing down every requirement and its readings before building prevents misreading | Hard set 15/36 vs 8/36; held-out 6/30 vs base 7/28 | about the same | Failed the held-out check; off |

### grind (`evals/harbor_v2/grind-gate.ts`)

If the builder finishes before a quarter of the trial's time has passed (capped at one hour), the harness sends it back to try to break its own result. It does this at most twice, and never with less than 15 minutes left. The notice names no task or check.

- **Result:** the same pass count at 1.6x the cost. The extra rounds found nothing the grader cared about.

### effortMix (`evals/harbor_v2/effort-mix.ts`)

The first two model requests run at the turn's effort (planning) and later ones are capped at high. Continuation rounds restore the top effort. The transport log records each request's effort.

- **Result:** 1/12 vs 2/12. It saved tokens but lost a pass.

### envSnapshot (`evals/harbor_v2/env-snapshot.ts`)

One fixed, read-only probe runs before the first request: OS, resources, file tree, project files, tools, network and processes. It is capped at 3,000 characters and 20 seconds, and placed above the request under "Environment facts gathered by the harness before you started (verify anything critical)".

- **Result:** 4/12, within noise of base.

### goal (`src/domain/goal.ts`, `src/server/services/goal-tool.ts`)

The request becomes the run's goal, and the builder gets a `goal` tool (`get`, or `update` with `complete` or `blocked` plus evidence `[{requirement, proof}]`). While the goal is active the harness sends the builder back with an audit notice. It stops on:

- complete
- blocked
- no progress for 3 idle turns
- a deadline wrap-up when under 5 minutes remain
- at most 6 continuations

Goal supersedes grind.

- **Result:** 3/12, within noise of base.
- **Why we keep it:** it is meant for long product tasks, not benchmarks. See "Goal mode in Codex and Claude Code" below.

### ledger (`evals/harbor_v2/requirement-ledger.ts`)

The builder gets a `requirements` tool (`set`/`get`) and a first-message note. Before building, it records each requirement as:

- a **verbatim quote** from the request;
- its **readings**, with whether each is satisfied. For an ambiguous sentence, the agent lists two or more readings and builds one deliverable that **satisfies every reading that does not conflict**;
- **one shell check command**.

When the builder finishes, the harness runs every check (120 seconds each, 8 minutes per round) and sends failures back, at most twice. The gate is skipped when under 10 minutes remain, and it shares its cap of 3 finish continuations with grind.

**Results:**
- First batch, hard set: 6/12 vs 2/12.
- Confirmation batch, same tasks: 9/24 vs 6/24.
- Combined: 15/36 vs 8/36 (p about 0.13). kv-store-grpc went 6/6 vs 2/6 and video-processing 4/6 vs 2/6. The lead shrank on confirmation.
- **Held-out check on 8 fresh TB 2.1 tasks: 6/30 vs base 7/28.** No gain. On 15–30 minute tasks the gate was often skipped for lack of time.
- The gains on the hard set came from quoting requirements and recording readings, **not from the gate**. The gate never caught a failure.

**Verdict:** the hard-set gain did not generalize. Don't propose the ledger again without a new idea; an ablation of its parts is moot.

## Novelty check of the ledger

Searched papers, agent harnesses and vendor posts on 2026-10-25.

**Already done elsewhere:**
- Deriving requirements and auditing evidence per requirement: Codex `/goal`'s completion audit (prompt-level, run by the model).
- A harness-run finish gate: Claude Code Stop hooks, the Ralph loop, GTDD (arXiv 2610.02952), Bounded Loops (arXiv 2609.27871).
- Turning requirements into executable acceptance tests: AlphaCodium (2401.08500), TDDev (2605.17242), TiCoder (2404.10100).
- Detecting ambiguity and asking for clarification: ClarifyGPT (2310.10996), Ambig-SWE (2502.13069), GitHub Spec Kit, Kiro, SpecFix (2505.07270), REAgent (2604.06861).

**Not found anywhere:**
1. A verbatim quote per requirement, forced through a tool call.
2. The non-interactive hedge: enumerate two or more readings and build one deliverable that satisfies all non-conflicting ones. Prior work asks the user, picks one reading, or outputs several answers (e.g. arXiv 2511.10453).

Absence of evidence is not proof: Factory, Warp, [competitor], Augment, [competitor], OpenHands and Reason Machines publish only scores and general harness posts. The combination was new, but the held-out check showed no gain, so there is nothing to claim.

## Goal mode in Codex and Claude Code

**Codex `/goal`** (openai/codex at commit 970111f, `codex-rs/ext/goal/`):
- **State:** the goal is stored in SQLite (`thread_goals`), outside the transcript, so compaction cannot remove it.
- **Who says done:** the working model, through `update_goal{status: complete | blocked | paused}`. There is no separate judge.
- **Continuation:** on idle, the runtime starts a new turn with `continuation.md`, a hidden user-role message. It contains the objective, the token budget, a no-progress check, fidelity rules ("do not substitute a narrower ... easier-to-test solution") and a requirement-by-requirement completion audit.
- **System stops:**
  - the token budget (non-cached input plus output, including subagents);
  - 3 empty automatic turns;
  - 3 turns whose exec calls all failed;
  - turn errors;
  - usage limits.
- Elapsed time was removed from the prompt because it made the model shortcut.
- **Not in benchmark runs:** `codex exec` exits after the first turn, so Codex's Terminal-Bench scores are not goal-mode scores.

**Claude Code `/goal`** (docs: code.claude.com/docs/en/goal):
- **Mechanism:** a session-scoped prompt Stop hook. After each turn, a small fast model reads the condition and the conversation and returns "not yet met", "met" or "impossible". The judge has no tools.
- **Stops:** it stops after several turns without tool use (Stop-hook cap of 8).
- **Headless:** works through `claude -p "/goal ..."`.

**Ours:** model-owned completion as in Codex, but `complete` requires evidence per requirement, and the stop rules are deterministic, harness-side. No benchmark (ours or public) shows goal mode raising a pass rate.

## Tasks every arm failed (diagnosis only)

configure-git-webserver and mteb-retrieve failed on every arm (0/12 each). extract-elf passed once out of 18.

| Task | What went wrong |
|---|---|
| configure-git-webserver | Every agent read "I'll setup login" as "don't set up SSH", then tested with a local-path clone instead of the `user@server:` transport the request names |
| mteb-retrieve | The agent computed both rankings (with and without the model's registered query prompt) and picked the literal one; the grader expects mteb's native retrieval path |
| extract-elf | The agent took the example's 0x400000 base as normative although the example's values contradicted the binary |

Fixes were proposed from these failures (run the client's exact commands; check an example against the real input before trusting it). They were **rejected as tuning** because they were derived from grader output.

**Standing rule:** no harness rule may come from any benchmark's grader output, TB 2.1 included. Grader output is for diagnosis only.

## TB4 untouched-subset check

**Setup:**
- Harness frozen at tag `tb4-frozen-2026-10-25` (f50e45b), base switches, Bedrock Sol max, one trial per task.
- **Tasks:** the 25 validation, test and unstudied-reserve tasks, none ever run or tuned by us under this harness.

**Result: 14/25, identical to Codex on every task.**
- All 14 tasks Codex passes 5/5, we passed.
- All 11 tasks Codex passes 0/5, we failed.

| | Tasks |
|---|---|
| Passed (Codex 5/5) | coq-block-bound, embedding-drift-monitor, fin-saccr-rwa, formal-crypto, freecad-platform-drawing, hof-topology-interpenetration, layout-config-recreation2, legacy-utility-triage, mp-checkpoint-consolidation, photonic-waveguide-routing, risk-scorer-replay, satb-audio-transcription, sound-change-cascade, uefi-bootkit |
| Failed (Codex 0/5) | foodstuff-beta-activity, freecad-impeller, freight-dispatch-shift, glycan-ms2-elucidation, gsea-proteomics, intrastat-meldung, medical-claims-processing, ontology-kg-querying, production-planning, react-lead-form, vllm-deepseek-streaming |

- The frozen v13 harness once passed intrastat-meldung (3/5) and vllm-deepseek-streaming (2/5). Neither passed this time.
- **Cost:** $30.70 vs Codex $25.54 for the same 25 tasks at list price (+20%; Codex's figure is its per-task average over 5 trials).
- **Caching:** 89.6% of input tokens were cached. fin-saccr-rwa was only 57% cached; that cache break is worth investigating because it costs money on every model.

**What it means:**
- **No regressions:** we keep everything Codex reliably passes.
- **It cannot show a win.** By construction every untouched task is all-or-nothing for Codex. The tasks Codex passes sometimes, which decide the score, are all in the dev split we studied. Only the full frozen run (5 trials per task, about $300–550 on Bedrock) measures the gap to 58.6%.

## Operational notes

- **Subscription limit:** the Codex subscription ran out after about 44 parallel Sol trials in 90 minutes, and reset about 4 hours later. Keep parallel subscription trials near 10, and switch to Bedrock when the limit hits.
- **Remote runs:**
  - Run `ssh` in loops with `-n`.
  - Kill runs with `pkill -f "[h]arbor run"`, so the pattern doesn't match the ssh session itself.
  - Delete staged AWS credentials when a host terminates.

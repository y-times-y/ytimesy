# Instruction tuning

Development only. The builder's tools are fixed (the lean surface for every model, docs/decisions/2026-10-17-lean-tool-surface.md). What this tunes is the **behavioural guidance**: the procedure the model is told to follow on top of its tools. Each model family can get its own guidance profile, chosen from hard-set results (docs/hard-set.md), not from intuition.

## What is varied

The harness variant key `instructions` (src/domain/harness-variant.ts) picks a profile from src/domain/instruction-profiles.ts. Profiles apply to lean surfaces only (`toolSurface=lean` or `lean-native`, the default for every model); the older `current` surface keeps its v13-shell/v8 text.

| Value | Guidance |
|---|---|
| `default` | The model family's profile from `INSTRUCTION_PROFILE_BY_FAMILY` (production always uses this). `baseline` for every family today |
| `baseline` | The v13-lean guidance, byte-identical to before profiles existed (a test pins its hash) |
| `verify-hard` | baseline + one paragraph: before finishing, write the checks a strict hidden suite would run, derived from the task text (every requirement and option, boundaries, empty/malformed/large inputs, ordering, repeated runs, exact output format, names and paths), run them in one script, fix the logic, and run deliverables from a clean copy with `ytimesy-check` |
| `plan-first` | baseline + one paragraph: before the first edit, a plan of at most ten lines with a numbered checklist of every requirement quoted from the task and how each will be checked (no approval wait); before finishing, go through it item by item |
| `persist` | baseline + one paragraph: do not end the turn while any requirement is unmet or unverified and you can still act; after a failure say why before retrying; after two failures with the same approach, change approach; report a blocker only after trying the alternatives |
| `concise` | The guidance replaced by four sentences (reproduce early, complete fix, rerun tests; follow the task literally and never weaken tests; resolve ambiguity yourself; check every requirement including a made-up input, deliverables standalone). About a third of baseline's length: tests whether less is more |

Each additive profile targets one failure mode the hard set shows: weak self-verification (`verify-hard`), misreading the spec (`plan-first`), premature stopping (`persist`). None mentions a task, a benchmark or a tool the surface lacks. The non-baseline profiles name themselves in the guidance header (`Harness tool profile v13-lean+persist (openai)`). Every text is a constant, so a profile's system prompt is byte-stable across a chat's turns and steps and stays in the provider's prompt cache (src/server/services/prompt-cache-prefix.test.ts checks that across steps).

Plumbing: `api-turn` reads the variant once per turn and passes `instructionVariant` to the agent loop (`ModelAgentInput`), which resolves it with `instructionProfile(variant, family)` and hands the profile to `harnessModelToolInstructions`. Production never reads `dev_eval_user`, so it always gets `default`.

## Per-model application

`INSTRUCTION_PROFILE_BY_FAMILY` (src/domain/instruction-profiles.ts) maps each family from `harnessModelFamily` (openai, anthropic, google, other) to a profile. Applying a tuning result is a one-line change there plus the test in instruction-profiles.test.ts that pins the mapping. Changing a family's entry changes what `default` means for it; `baseline` stays selectable, so later rounds can still compare against the old guidance (`--variants` always includes `baseline`).

## Running a tuning round

```
node --env-file=.env --import tsx scripts/instruction-tuning.ts --plan --run tune-1019 --models gpt-6.1-sol,google/gemini-3.8-flash
node --env-file=.env --import tsx scripts/instruction-tuning.ts --live --run tune-1019 --models gpt-6.1-sol
node --env-file=.env --import tsx scripts/instruction-tuning.ts --report --run tune-1019 --models gpt-6.1-sol
```

- `--models`: Codex model ids (the owner's subscription) and `google/<model>` (the development Gemini key, `--google-key-file`, default `.secrets/gemini-api-key`; see docs/hard-set.md, "Models").
- `--variants` (default all five; `baseline` is always added), `--tasks` (`all`, a category `hard`/`time-pressure`/`control`, or task ids), `--repeats` (1-10), `--agent-minutes` (default 7), `--reasoning` (Codex effort).
- `--plan` prints the schedule size, wall time, quota and list-price estimate and runs nothing. `--live` runs it, then collects slow graders and prints the report. `--report` ranks what is recorded.

How it runs: every unit of work is one `scripts/hard-set.ts --live` child process (ten-minute ceiling) for one model and one profile, with `--variant instructions=<profile>`. Codex runs a hard-set chunk (≤4 tasks side by side) per invocation; Gemini runs one task per invocation, because its free tier is shared by the whole project. At most two invocations run at a time, at most one per Gemini model. Records land in `.ytimesy/hard-set/<run>.<model>.<profile>/`, one hard-set run per (model, profile); repeats are attempts 2, 3, ... of the same run.

Usage limits: a Codex usage-limit turn stops that model's queue (the hard-set records are not scored) and the other models carry on. Gemini: each invocation first sends one tiny probe request; a 429 there or a rate-limited turn makes the runner read the quota: a per-minute limit is waited out and the job requeued (at most three times), a daily quota (a `PerDay` quota id, a reset more than 15 minutes away, or a quota of 0) stops the Gemini queue. Rerunning the same command resumes: a task's repeat counts as done once its run holds that many scored (or still grading) attempts. Ctrl-C stops after the running invocations, which cancel and clean up their own eval users and VMs.

## How to decide

The report prints, per model and profile: passes/scored, the pass rate on the tasks every profile scored ("common rate", the ranking key; then list-price cost and agent seconds per solved task), passes per category, paired wins/losses against baseline per common task, mean agent seconds of passing runs, tokens and cost per solved task, and the cache hit share.

- A difference of one or two tasks is noise: one task's TB4 trials often split 2/5 or 3/5. The report says so and recommends **keep baseline** unless the best profile leads by at least three common tasks' worth of passes with more paired wins than losses.
- With fewer than three repeats such a lead is only **promising**; repeat before changing anything.
- **Adopt** only after three or more repeats, then set the family's entry in `INSTRUCTION_PROFILE_BY_FAMILY` and confirm with one more round of that profile against `baseline`.
- Look at the categories, not only the total: a profile that wins hard tasks but loses time-pressure tasks (`persist` and `verify-hard` spend time) may still be wrong for a short budget.

## Fairness rules

- Same tasks for every profile of a model: the ranking uses only tasks every profile scored; unscored records (usage limit, setup error, short budget, still grading) are left out for every profile alike.
- Interleaved: each profile runs a batch next to the others (rotating which goes first), so infrastructure, image pulls and provider load affect all profiles alike. Never run one profile today and another tomorrow.
- Repeats: 3+ before adopting. Use a new `--run` prefix per round; repeats within a round are attempts on the same runs.
- One change at a time: compare profiles on otherwise identical variants (same tool surface, memory, code mode). Do not tune on top of an untested variant.
- The hard set is a dev set chosen from our failures (docs/hard-set.md, Contamination): never present a tuning result as held-out evidence or a Terminal-Bench score.

## Estimated cost per round (20 tasks × 5 profiles × 1 repeat)

From `--plan` with the measured inputs in `ROUND_FACTS` (scripts/instruction-tuning/plan.ts):

- **GPT-6.1 Sol (Codex subscription)**: 30 invocations, 100 task runs, about 2.5 hours of wall time at two at a time. Codex usage 1.5-2% of the 5-hour window per task run, so 150-200%: a round spans two to three 5-hour windows and, at a few percent of the week per 20 task runs, roughly 10-25% of the weekly allowance; the runner stops at the limit and the same command resumes later. $11-36 of tokens at list price (an estimate; the subscription pays), plus $10-15 of VMs.
- **Gemini 3.8 Flash (free tier)**: 100 invocations (one task each), about 17 hours of wall time. The free tier allows 5 requests per minute per project and model (measured 2026-10-18; the 429 names `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`), which caps a 7-minute run at about 35 model steps and makes rate-limit stalls likely. The round needs about 1,500-3,500 requests; the free tier's daily request quota (not published per model; see AI Studio's rate-limit page, resets at midnight Pacific) almost certainly does not cover that in one day. On the free tier, tune Gemini on a subset (`--tasks hard --variants <one or two>`) over several days, or use a paid-tier key. Tokens would cost $4-13 at list price; VMs $10-15. Gemini 4 Argon has a free-tier quota of 0 on this key and cannot be tuned without billing.

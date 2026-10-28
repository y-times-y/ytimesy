# Delegation middle rule (2026-10-28)

One delegation rule for product and benchmark (no modes), in
`src/domain/delegation-policy.ts`, composed by the product's orchestrator
block and the bridge's helpers=on/write sections (bridge mechanics lines kept).
Model: GPT-6 Astra xhigh, Bedrock (mantle us-east-1). The Codex subscription
was used up until 17:06 PT, so everything ran on Bedrock.

## Rule text (final = v1, the only tuning iteration)

Writers: "Writers: decide once, after your first look at the task and its
files, and never later. Start writers when the work splits into two or more
parts that touch different files, can each be built and checked without the
others, and are each a real job on its own (their own investigation, change
and checks, not a few edits): one writer per part, started together. [own
files / interfaces / integrate yourself: unchanged] One focused change, even
across several files, or steps that depend on each other, you do yourself."

Readers: "A helper costs about as much as you do and re-reads what it needs;
what it buys is time and a smaller context for you. Start one only for an
independent investigation likely to take over 10 minutes, while you have
other work to do meanwhile; when a broad investigation splits into several
such areas, start one per area together. Small, quick or sequential work, or
anything you would finish in a few steps, you do yourself."

vs strict (8717fc6): writer bar "each part is a large job on its own (hours
of work or thousands of lines)" -> "touch different files, built and checked
without the others, each a real job (own investigation, change and checks,
not a few edits)"; "Otherwise do all the work yourself" -> "One focused change,
even across several files, or steps that depend on each other, you do
yourself". Reader rule adds what a helper buys (time, smaller context) and
one-per-area for broad investigations; the 10-minute bar is kept.
vs current (origin/main): no wall-clock "over 5 minutes" trigger, no
"long build beside a fix", "reviewer after a hard fix" or "isolation"
triggers; writers decided once after the first look.

## Product probe (evals/delegation-probe, product interactive prompt)

Run cap $2.50, stop at first `agent` call or 12 requests. Runs ending at the
12-step limit count as no delegation.

| Arm | Set | YES hit | NO false alarm |
|---|---|---|---|
| strict (earlier, $1.50 cap) | tuning, 1 run | 2/4 (2 cut by cap) | 0/4 |
| current (earlier) | tuning, 1 run | 4/4 | 1/4 (writer on dark mode) |
| middle v1 | tuning, 2 runs | 6/8 | 0/8 |
| middle final (=v1) | held-out, 1 run | 5/5 | 0/5 |

Tuning misses: q4 "upgrade all dependencies" 0/2 (it upgrades first, then
would split the breakage; "decide once" forbids the late split). q2 delegated
at request 6 and 8. Held-out: 1 run each (not 2), by the coordinator's
instruction to finish sooner within the cap. EITHER items (q9, q10) not run.

## Terminal-Bench trigger check (bridge, helpers=write, 10 requests, 1 run)

| Task | strict r1 / r2 (2026-10-27) | middle |
|---|---|---|
| takens-embedding-lean | writers / writers | 2 writers |
| retro-console-soc | writer+researcher / writer | 2 writers |
| rs-archive-clone | researcher / researcher | 2 writers |
| lake-temp-glm | researcher / researcher | researcher |
| sglang-qwen-burst | none / researcher | none |
| telecom-entity-resolution | researcher / none | researcher |
| hof-topology-interpenetration | none / none | 2 writers (new false positive) |
| biped, distributed-dedup, kv-live-surgery, mvcc, session-window, shadow-relay | none | none |

Positives 4/5 (strict 9/10 over two runs). Non-spawn tasks 2/8 (strict 1/16
on these 8); hof is a new writer pair, and rs-archive moved from one
researcher to two writers: writers are heavier than strict's on tasks with
separable parts.

## Cost

$42.27 on Bedrock (ledger in evals/delegation-probe/results-middle): tuning
$16.73, TB4 $13.64, held-out $11.90.

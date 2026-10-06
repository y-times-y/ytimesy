# OMP gap implementation: paired local measurements

The change improves warm query batching and cold-query correctness. Structural
outlines reduce output size but cost more tool execution time. Overall coding
speed, model cost and task success have not been measured.

Compared implementation `6136eec` against its Cursor-gap baseline `d998928`.
Aggregate observations are in `omp-harness-performance-2026-10-06.json`.

## Method

Apple M2 Pro, macOS, Node v25.9.0. Both arms use the guest's exact pinned
TypeScript 6.0.2, typescript-language-server 6.0.1 and vscode-jsonrpc 9.0.3.
The benchmark executes the actual committed guest programs locally; it does
not simulate a language server or substitute mocked responses.

Eight paired repetitions alternate which revision runs first. Each arm starts
its own daemon in a fresh two-file TypeScript project. The fixture has exactly
three references to an exported constant. After the cold references query,
three warm samples query references and hover. The treatment alternates batch
and sequential sample order. Temporary projects and owned daemons are cleaned
up. Timings include local guest-client process startup and socket transport.
They exclude VM provisioning/network, capability installation, hosted tool
wrappers, model inference, review and integration. The machine is shared rather
than a dedicated performance runner. These are small-workload measurements.

Outlines and baseline Python full reads use identical source files from
`6136eec`, with eight alternating-order samples per file. Both responses are
normalized to compact JSON before counting UTF-8 bytes. Full reads are checked
against exact source and must not be truncated. Outlines must be interpreted as
partial evidence; they omit bodies. Response bytes are not model token counts.

## Results

| Operation | Baseline median | Treatment median | Interpretation |
| --- | ---: | ---: | --- |
| Cold references, eight samples | 665 ms | 661 ms | Similar time; baseline finds 1/3 references in all eight runs, treatment finds 3/3 in all eight |
| Two warm queries sequentially, 24 samples | 177 ms | 169 ms | Small difference; insufficient evidence for a meaningful standalone speed gain |
| Two warm queries, baseline sequential vs treatment batch, 24 samples | 177 ms | 89 ms | About 50% lower local elapsed time; both return all references and hover |

Batching is faster in every paired repetition: per-repetition median reduction
against the baseline ranges from 41% to 53%. Comparing the treatment's own batch
to its sequential calls isolates batching from the language-server configuration
change: median 89 vs 169 ms, about 47% less time. Batching uses one guest execution
rather than two. It still serializes language-server requests.

| File | Full read median | Outline median | Full response | Outline response | Byte reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| api-agent-file-tools.ts | 31 ms | 199 ms | 31,567 | 7,618 | 75.9% |
| model-agent-loop.ts | 31 ms | 196 ms | 23,435 | 6,221 | 73.5% |
| warm-language-intelligence.ts | 32 ms | 191 ms | 12,939 | 481 | 96.3% |

The last file mostly embeds a program in a string, so its outline contains one
declaration and does not explain that embedded program. Its large byte saving
is not evidence of equally useful information. All outlines report `ok` without
declaration truncation. Outline generation adds roughly 160–170 ms relative to
a full read on this machine. Follow-up source reads add further cost. Whether
context savings outweigh that cost depends on model behavior and task workload.

## Conclusion and remaining evaluation

Keep batching and the semantic-server correctness fix. Use outlines selectively
for locating relevant declarations in large files, as the tool guidance already
instructs. This benchmark does not establish that every turn gets faster, or
that agents choose the new tools effectively. Applied rename behavior passed
the real integration fixture, but its performance versus model-generated edits
was not timed here.

A complete before/after coding evaluation needs the same model, prompt, task,
environment and budget, with independently graded outcomes and review overhead.
The existing cloud evaluator compares ytimesy to native Codex; it cannot be used
unchanged as a before/after revision comparison. Its README also requires fresh
VM-spend and model-quota authorization before launches. No cloud evaluation,
deployment, paid requests or VM creation occurred during this local benchmark.

## Reproduce

From this worktree, with normal project dependencies already installed:

```sh
npm install --prefix .ytimesy/perf/runtime --no-audit --no-fund --ignore-scripts typescript@6.0.2 typescript-language-server@6.0.1 vscode-jsonrpc@9.0.3
node --import tsx scripts/benchmark-omp-tools.ts
```

The script reads both committed revisions through Git and writes raw observations
to ignored `.ytimesy/perf/omp-tools.json`. The aggregate JSON preserves medians,
ranges, correctness counts and paired reductions. No inference is needed.

# Final harness fix: live matched model proof

The final implementation passed all six raw protected coding grades, but it did
**not** improve overall speed on this task. Across three matched pairs, mean
builder-plus-grader time increased from **33.802 s to 41.951 s (+24.1%)**.
Median time increased 9.1%; actual model requests increased from 23 to 30.
The earlier diagnostic-wait regression is fixed. A general harness performance
advantage remains unproven.

## Frozen comparison and observed results

Baseline `d99892899b207e490cde7e09dddefb166c830ddd` and final committed treatment
`ac71cdfc7c6bcfd75d3927c1c0c3417626d290c5` ran their actual builder model loops
and VM tools. Both used connected Codex subscription model `gpt-6.1-sol`, low
reasoning, the same unchanged TypeScript/Python pricing task and verifier,
ten requests per arm, 6,000 maximum output tokens per response, and a 200-second
model/tool deadline. Every provider invocation, including retries, consumed the
persisted shared request counter before transmission. Credentials stayed on the
operator host; there was no API fallback.

| Pair | Run order | Baseline time | Final time | Baseline requests | Final requests | Raw protected grade |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Before, after | 37.028 s | 37.005 s | 8 | 10 | Both passed |
| 2 | After, before | 35.443 s | 50.161 s | 8 | 10 | Both passed |
| 3 | Before, after | 28.935 s | 38.686 s | 7 | 10 | Both passed |
| Mean | | 33.802 s | 41.951 s | 7.67 | 10 | 3/3 each |
| Median | | 35.443 s | 38.686 s | | | |

All six reached a final response with `reason: stop`, without model-loop failure.
The grader checks percentage arithmetic edge cases in both languages, symbol
and file renames, callers/imports, preserved unrelated helper bodies, strict
TypeScript diagnostics and allowed-path scope. Each raw patch passed its 92
protected assertions; no patch normalization or source filtering was needed.
The broken fixture failed and known correct patch passed before inference.

## What explains the result

| Sum across three arms | Baseline | Final |
| --- | ---: | ---: |
| Actual model requests | 23 | 30 |
| Reported input tokens | 335,258 | 457,036 |
| Reported cached input tokens | 224,128 | 332,800 |
| Reported output tokens | 2,227 | 2,386 |
| Model duration | 80.414 s | 104.416 s |
| Tool duration | 14.077 s | 15.400 s |

The baseline used a shell move and direct patches. Each treatment run used
`rename_symbol`, `rename_file` and a follow-up `read_code`, adding model turns.
Treatment symbol renames took 1.864–2.228 seconds; file moves took
0.274–0.640 seconds. The old 31-second file-move diagnostic wait did not recur.
Most of the aggregate extra time was in model responses, alongside more requests
and 36.3% more reported input tokens. Cached tokens are included in input totals;
these are provider-reported usage, not dollar billing. These observations identify
the measured source of time, rather than establish a universal causal effect.

## Isolation, budget and evidence

One fresh disposable VM used 2 vCPU, 4 GiB memory and 16 GiB storage. Every arm
started in a separate clean fixture directory with identical Git history and
equal preinstalled dependencies. Order alternated between pairs. The immutable
grader ran on the host without network, capabilities, VM credentials or `.git`;
the verifier and reference patch were never sent to the coding VM.

Approval was $5 VM spend and 60 additional model requests; **53 requests were
used**. The provider lifetime was capped at 1,800 seconds with no restart and
no snapshots. At the maximum accepted 4-vCPU/8-GiB/32-GiB resource envelope,
the conservative compute/storage lifetime estimate is below $0.14; a $1 transfer
reserve keeps the planned envelope below $5. This is an estimate, not an invoice
audit. [Freestyle prices](https://www.freestyle.sh/pricing) were checked live
before launch. Deletion completed and a fresh provider read confirmed HTTP 404.

Zero-inference real-VM checks also passed pinned Python preparation, persistent
service and warm LSP reuse, outlines, file-move import updates, organize-imports,
and Python DAP breakpoint/locals/step/stale-reference rejection.

The [sanitized observations](omp-harness-final-model-proof-2026-10-06.json)
retain source/task/verifier/image/protocol pins, every arm, tool timings and
SHA-256 hashes of private raw patches and traces. Counter and trace totals were
cross-checked. Raw evidence stays in the ignored private run directory; the
previous slower experiment is retained separately.

This is one known development task repeated three times on a shared VM, not
three independent problems or a holdout. Installation and capability preparation
are outside arm latency; model/tool execution, patch capture and protected
grading are inside. It does not test native Oh My Pi or Codex CLI, production
queue/leader/reviewer/durable receipts, or other native debugger environments.
No confidence interval or general quality/speed superiority claim is justified.

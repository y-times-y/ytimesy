# Builder performance pilot: no demonstrated gain

Treatment: `2bc6ad3`. Control: ytimesy builder `d998928`, **not native Codex**.
One frozen TypeScript/Python pricing-refactor problem, GPT-6.1 Sol, low reasoning,
fast mode off; identical task, preinstalled dependencies, protected verifier and
disposable 2-vCPU / 4-GiB VM. Control ran first; one pair is not a statistically
reliable estimate or independent-task campaign.

| Metric | Old builder | Updated builder |
| --- | ---: | ---: |
| Protected grader | Pass (92 assertions) | Pass (92 assertions) |
| Attempt time, including grading | 38.757 s | 53.030 s |
| Provider requests | 8 | 10 |
| Input tokens | 115,997 | 144,616 |
| Output tokens | 771 | 493 |
| Cached input tokens (subset of input) | 63,744 | 99,840 |
| Uncached input tokens | 52,253 | 44,776 |
| Final response | Completed | Missing: tool-step limit |

Observed time increased 36.8%; requests increased 25%; total input plus output
tokens increased 24.3%. Uncached input decreased 14.3%, but this is not a dollar
cost measurement, and does not offset the completion failure. Subscription quota
and cached-token billing cannot be inferred from gross token totals alone.

## Trace observations

The control used shell inspection and a batch patch. The updated builder used
`rename_symbol`, `rename_file`, another `read_files` and `read_code` before its
batch patch/check/diff/output sequence. Those additional turns are visible in the
trace. Neither arm used `compose_tools`. The treatment reached the unchanged
ten-request limit without a final answer; retain that failure even though its raw
patch passed the grader. This test does not justify increasing the limit to hide
the regression.

## Scope and safety

The pilot exercises the actual builder model loop, discovery and repository/VM
tools. It excludes the production queue, leader/reviewer, database-journal
durability, browser interaction and durable-plan recovery. The protected grader's
negative and positive controls passed before inference. Eighteen of twenty
allowed provider requests were consumed. One disposable VM was deleted; no
snapshot was created. Raw traces, patches and resource identifiers stay in the
ignored private evaluation directory.

The VM tool preflight exercised outlines, file moves/code actions, warm LSP and
Python debugger operations. Mechanism success is separate from coding speed.

## Conclusion

No native-Codex parity or superiority is established. This development pilot
shows a regression against the old ytimesy builder and incomplete turn delivery.
The next optimization hypothesis is fewer unnecessary specialist-tool round trips,
not more tool availability. Validate that hypothesis on independent tasks before
claiming a general improvement. Do not tune the grader or task to reward the
treatment.

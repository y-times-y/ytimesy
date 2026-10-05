# Benchmarks for a faster coding harness

Checked against benchmark-owner sources on 2026-10-03. This is a proposed evaluation protocol, not a benchmark run or evidence of a 100× improvement.

## Public choices

**Primary: SWE-bench Pro V2 for repository changes.** The current validated public split contains 642 tasks across 11 repositories; V1's 731-task results are a different protocol. V2 supplies versioned Harbor tasks, container images, checksums, sanitized Git history and a HARD-51 subset. Its locked protocol allows only the model endpoint during the agent phase, disables web search/fetch, captures the resulting patch, and applies it to a pristine sandbox for authoritative grading. The task budget is 50 minutes, including partial patches at timeout. Run the network/history probes and oracle/empty-patch controls before trusting an integration. Use HARD-51 for a declared pilot, then the complete split for broader claims; selection by previous model failures makes the subset unsuitable for an unbiased general performance claim. [Scale's V2 protocol](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/v2/README.md)

**Secondary: Terminal-Bench 4.0 for broader terminal work.** The owner currently directs users to `terminal-bench/terminal-bench@4.0.0` through Harbor; the example uses five attempts. Some tasks require GPUs, so a CPU-only environment cannot reproduce the complete benchmark. Use it to test tool execution and environment work beyond issue-to-patch coding; publish any restricted subset explicitly. The site reports resolution rate with 95% confidence intervals, cost and tokens, and prohibits benchmark data in training corpora. [Owner run guide](https://www.tbench.ai/run), [owner benchmark site](https://www.tbench.ai/)

## Harness identity and contamination

Harbor supports custom agents, and its tasks can be consumed outside Harbor. Integrate the actual ytimesy orchestration through that boundary: running Harbor's stock Codex adapter measures that adapter, not ytimesy's server loop, delegation or persisted context. Preserve benchmark instructions, budgets, network policy and grading; otherwise describe the result as a modified evaluation. [Harbor agents](https://docs.harborframework.com/core-concepts/agents/pre-integrated-agents), [task format](https://docs.harborframework.com/core-concepts/tasks/overview)

Public reference solutions and tests make contamination possible even with offline execution; offline access controls cannot establish what a model already learned. Keep solutions/verifier assets inaccessible to agents, freeze the harness before held-out runs, prohibit task-specific rules, clear cross-task memory, and retain complete traces. Report model, reasoning, prompt, tools, versions, hardware, concurrency, budgets and every retry. A published system score does not transfer to a replacement harness.

## Product evaluation and speed claims

Make newly authored private workflow tasks the main product gate: real repository edits, independent hidden regression tests, reviewer acceptance, steering, interruption/reconnect and multi-writer integration. Split development and held-out tasks; author acceptance criteria before observing either arm, and prevent evaluation-only task hints from entering production prompts.

Compare baseline and candidate on paired tasks with randomized arm order, repeated attempts, equal model/reasoning and declared budgets. Report success rate, median/p95 end-to-end time, failures/timeouts, cost and total compute across all children. Show setup separately and include it in user-visible latency; evaluate cold and revision-validated warm context separately, charging preparation costs. Faster failures are not speedups. Report time among shared successful tasks alongside overall success and uncertainty; never discard failed runs or report parallel throughput as single-task latency. A 100× claim requires those measurements at comparable accepted quality.

# Coding harness speed: a narrower gap worth testing

Research snapshot: 2026-10-04. Public sources read through agent-browser; no paid runs, implementation, or authenticated product testing.

The plausible direction is **reduce time to an accepted, verified change by scheduling the critical path and reusing unaffected verification work**. Parallel agents and dependency graphs are already occupied territory. The remaining opportunity is a measurable improvement in end-to-end latency, not a new orchestration label.

## Documented pain

Cursor's February 5, 2026 [Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases) identifies several concrete bottlenecks: a batch executor waited for its slowest worker; an integrator became a central gate; requiring every intermediate commit to be perfectly correct caused serialization and agents trampling the same fixes. At larger scale, hundreds of compilations saturated disk with build artifacts and compilation dominated throughput. Splitting the project into more self-contained crates produced multiple-times throughput in their research runs. These are first-party research observations, not a controlled speed comparison or a promise about customer Cloud Agents.

Anthropic's June 13, 2025 [multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) similarly describes synchronous batches blocking on one subagent. It also warns that coding has fewer independent tasks than research and that shared context and dependencies limit parallelism. The post is historical evidence of the problem shape; it does not establish the present architecture of Anthropic products.

## Adjacent solution

[Bazel's incremental-build documentation](https://bazel.build/run/build#correct-incremental-rebuilds) describes a dependency graph and re-execution when relevant inputs, outputs, or commands change. Its separation of loading, analysis, and execution makes the useful transfer concrete: invalidate only affected work and execute ready independent nodes. Important boundary: Bazel explicitly does not guarantee consistency when files change during a build. Agent verification therefore needs immutable revision identity and complete environment/toolchain inputs, rather than treating yesterday's green result as today's evidence.

This technique can apply directly to deterministic build/test actions. Reusing an agent's reasoning or claiming a behavioral acceptance check is equivalent across revisions requires a separate proof; an LLM's asserted dependency list is not a sound build graph.

## Intersection check

[Codex's current official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) explicitly supports agents working in parallel, including codebase exploration and feature plans. Current local releases delegate on a direct request or applicable project/skill instructions. It warns that parallel writes create conflicts and coordination overhead. A comparison that describes Codex as sequential-only is false.

[Vorflux Plan Mode](https://vorflux.ai/docs/plan-mode), verified in the rendered browser, already dispatches independent builders in parallel and sequences dependent tasks behind prerequisites. Cursor's February research already replaces rigid batches with recursive planners and continuous handoffs. [Harness Engineering](https://github.com/Intense-Visions/harness-engineering) publicly advertises test selection, hard verification gates, autonomous phases, and parallel worktree patterns; the parent investigation additionally found its dependency-bearing DAG implementation. These establish real overlap, without demonstrating production reliability or identical algorithms.

**Conclusion: the broad intersection is claimed.** This short investigation does not confirm an unclaimed combination of critical-path priorities, revision-scoped verification reuse, and early verified previews. Undisclosed competitor internals are unknown, not absent. Further npm/GitHub/HN search and implementation inspection would be required before asserting novelty.

## Product hypothesis and falsification

Hypothesis: for dependency-heavy changes, a harness can deliver useful verified feedback sooner by identifying the blocking API/schema task, preparing independent consumers and checks concurrently, scheduling newly ready work immediately, and invalidating verification only when its actual inputs change. An optional race between alternative implementations could target a slow uncertain prerequisite; blanket racing would increase cost and conflict.

Show an early preview with exactly what has been verified at that revision. Keep the final acceptance checks unchanged. Measure time to first verified useful behavior and time to final accepted green change, alongside regressions, human interventions, inference spend, and duplicated compilation. Compare against native Codex using its parallel capabilities, with the same model, task, environment, and budget. If final-green time or cost gets worse, earlier partial output alone does not prove a speed win.

## Distribution fit

One-sentence story is accessible: “Get a working, tested change sooner by stopping agents from waiting and repeating checks.” Coding latency is a large market and autonomous coding is a current narrative wave, but no audience advantage or demand for this specific scheduler is established here. A public trace showing equal final tests, lower elapsed time, and honest spend is the strongest launch wedge. Whether those gains survive ordinary repositories and small tasks remains unvalidated.

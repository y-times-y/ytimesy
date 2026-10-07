# Harness efficiency audit — 2026-10-06

## Conclusion and scope

ytimesy has most of the necessary machinery. Its remaining disadvantage is not simply missing tools: it repeats preparation, carries large instructions, discovers some mistakes late, and leaves many scheduling and verification decisions to prose instructions. Those mechanisms can increase elapsed time and tokens without improving the final patch.

This is a current-source audit, not a performance ranking. I traced the active cloud model loop, subscription/API adapters, tool dispatch, editing, language intelligence, context/memory, child coordination, integration, publication, repair and recovery paths. Supporting modules were mapped and selected implementations inspected; this is not a claim that every historical adapter or test was reviewed line by line. No runtime code was changed and no inference, VM, build or paired benchmark was run for this audit.

The accompanying [upstream mechanics note](harness-upstream-mechanics-2026-10-06.md) records primary sources for Codex, Claude Code, [competitor], Oh My Pi, Pi, Aider, OpenCode, [competitor], [competitor] and [competitor]. Public documentation does not reveal [competitor]'s or the other commercial products' complete private implementations. Documented mechanisms are comparison evidence; their superiority on our workloads is not established.

## Existing capabilities we should preserve

- Server-hosted model loop with lazy workspace acquisition, provider adapters, subscription authentication and prompt-cache handling.
- Deferred optional tools and skills, batch reads and patches, lexical/symbol navigation, language-server queries, edit-time syntax diagnostics and browser inspection.
- Guarded exact edits and patch application, retained/paged command output, scoped command ownership and uncertain-side-effect protections.
- Opaque provider reasoning replay, capability-selected native compaction, fallback summaries and retained history.
- Project knowledge with source-freshness checks, isolated writable children, peer communication, completion wakeups and supervision.
- Reviewed imports, baseline-derived integration checks, actual command completion receipts, cancellation fencing, checkpoints and PR-repair plumbing.

Having these capabilities does not prove native-Codex-level quality or speed. Conversely, saying we lack LSP, editing feedback, search or compaction would be incorrect.

## Findings

### 1. Static instructions are expensive and insufficiently selective

The current lead role instructions contain **14,058 characters**; its model profile adds **4,922**, totaling **18,980 characters** before project guidance, memory, environment instructions or tool definitions. The builder equivalent totals **9,367 characters**. These are character counts, not measured tokens. The repository's `PLAN.md` is **92,320 bytes**, mixes current decisions with historical implementation detail, and is required reading by project instructions.

Sources: [role policies](../../src/domain/agent-orchestration.ts), [model profiles](../../src/domain/harness-model-profile.ts), [guidance loader](../../src/server/services/repository-guidance.ts).

Some guidance is repeated or broadly supplied despite being relevant only to specific edit/test situations. Cached input still consumes context and can have latency/cost. a competitor documents reducing static prompts, deferring tool descriptions and arranging stable cache layers. Its reported improvements are its own experiments, not savings we can assume. [Cursor token efficiency]([link removed]

**Better direction:** retain a compact stable contract; retrieve detailed procedures only when relevant. Separate the current project plan from historical records while preserving the user's required-reading rule. Do not silently skip required guidance.

### 2. Parallelism exists, but critical-path scheduling is mostly advisory

The lead's policies encourage independent writers and appropriate splits. The parallel-work planner checks estimated dependencies and overlapping ownership, but it is not a persisted execution graph that learns actual task duration, automatically refills independent work, or enforces every ownership declaration. The model still makes much of the timing decision. Every child also has preparation and integration overhead.

Sources: [parallel plan](../../src/domain/parallel-work-plan.ts), [role policies](../../src/domain/agent-orchestration.ts), [supervision](../../src/server/services/agent-child-supervision.ts), [integration](../../src/server/services/automated-task-integration.ts).

More builders are therefore not automatically faster. Keeping the read-only lead is an intentional product decision; the opportunity is shorter, evidence-rich handoffs and earlier work on genuinely ready independent tasks. [competitor] documents per-item pipelines instead of wave barriers. Oh My Pi documents speculative launches with parameter matching and cancellation, which is a possible later optimization—not permission to speculate billable VM side effects indiscriminately. [[competitor] workflows](https://docs.[competitor].ai/work-with-[competitor]/dynamic-workflows), [OMP task lifecycle](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/tools/task.md).

### 3. Validated discovery is not reused precisely enough

Project evidence requires matching HEAD, matching recorded file hashes, and **both checkouts entirely clean**. An unrelated dirty file invalidates reuse even if every recorded source is unchanged. This is safe but conservative. Child context draws on bounded keyword-selected project notes, rather than automatically receiving a compact, dependency-validated discovery packet for its assignment.

Sources: [freshness predicate](../../src/domain/project-source-evidence.ts), [project knowledge](../../src/server/services/project-knowledge.ts), [initial context](../../src/server/services/api-agent-context.ts).

**Better direction:** explicit evidence scopes and dependency-aware invalidation, with current instructions/settings included. Do not reuse semantic claims merely because a few files match. Aider's token-budgeted dependency-ranked repository map and [competitor]'s invalidated prepared-context reuse provide adjacent mechanisms. [Aider repo map](https://aider.chat/docs/repomap.html), [[competitor] changelog](https://[competitor].sh/changelog).

### 4. LSP works, but its lifecycle and edit feedback are weak for fast iteration

Each language query starts and initializes a language server, opens the document, then terminates the process. Diagnostics wait a fixed **2.5 seconds**. Capability installation is cached on the VM; it is not reinstalled on every query. Immediate edit diagnostics use TypeScript transpilation for eligible small JS/TS files; this is principally syntax feedback, not full project type or behavioral verification.

Sources: [language intelligence](../../src/server/services/language-intelligence.ts), [edit diagnostics](../../src/server/services/edit-diagnostics.ts), [language tools](../../src/server/services/api-agent-language-tools.ts).

**Better direction:** selective warm project sessions with versioned diagnostics and idle expiry, or cheap relevant CLI checks when those are faster. Feed actionable diagnostics into the edit result. Do not assume an always-running LSP is universally best: OpenCode currently defaults it off, and Claude's availability depends on configured plugins and environment. [OpenCode LSP](https://opencode.ai/docs/lsp/), [Claude code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence).

### 5. Safe edits have avoidable transport and preparation work

Patch preparation reads current source from the VM, applies a maintained diff implementation server-side, then sends a locked/hash-guarded write payload for guest execution. Batch reads help, but the path can still require additional source transfer and RPCs after the model already read the file.

Source: [file tools](../../src/server/services/api-agent-file-tools.ts).

**Better direction:** profile those phases; reuse immutable source snapshots or execute an appropriate maintained patch backend near the files. Preserve stale-write checks, actual edit receipts and safe failure semantics. This is a concrete optimization candidate, not a measured claim that RPC time dominates the latest run.

### 6. Context reduction is narrower and more blocking than the strongest examples

Compaction runs synchronously before another inference. Mechanical retirement targets consumed large guidance, not a general class of old reads/search results/check logs. The subscription runtime enables that retirement and a working-context target, whereas the generic API runtime does not enable the same settings. Context budgeting also includes the complete tool-schema collection despite selective tool exposure, potentially making it more conservative than actual requests.

Sources: [model loop](../../src/server/services/model-agent-loop.ts), [consumed guidance](../../src/server/services/consumed-guidance.ts), [subscription runtime](../../src/server/services/codex-subscription-agent.ts), [API runtime](../../src/server/services/api-agent-runtime.ts).

Providers without native compaction still have safe fallback constraints: a sufficiently large single active turn cannot always be summarized safely, especially with prefix-bound reasoning. That limitation must remain explicit.

**Better direction:** retire recoverable observations before inference-based summaries; make supported efficiencies consistent across adapters; consider speculative compaction only with strict snapshot/prefix invalidation. Preserve opaque reasoning, complete artifacts and call/result units. OMP documents mechanical `shake` and speculative compaction; Claude documents older-output clearing before compaction. [OMP compaction](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/compaction.md), [Claude loop](https://code.claude.com/docs/en/how-claude-code-works).

### 7. Verification has good receipts, but the required contract is not uniformly enforced

Reviewed integration derives checks from baseline policy and retains actual exits. Fast preflight and foreground-completion receipts are implemented. However, ordinary `run_checks` accepts model-authored command lists and can run two concurrently; independence is chiefly an instruction. Command success alone does not prove that every required check was chosen. Single-builder completion is not universally gated by an authoritative required-check contract.

Sources: [command tools](../../src/server/services/api-agent-command-tools.ts), [integration checks](../../src/domain/task-integration-checks.ts), [turn completion](../../src/server/jobs/api-turn.ts), [integration](../../src/server/services/automated-task-integration.ts).

**Better direction:** named baseline-approved check groups, explicit dependencies, cheap early checks and a final source-bound verification receipt. Avoid parallel checks that mutate shared generated artifacts. This concurrency concern is a source-level risk, not a newly reproduced failure. Preserve final behavioral checks; fewer tests is not an acceptable speed win.

### 8. Model-specific tuning is still mostly family-level guidance

Adapters implement real provider differences, but tool instructions are largely common prose with family-level variations and accumulated task-specific advice. We do not yet have evidence-backed per-model/version edit-format, reasoning-budget and tool-error calibration comparable to a competitor's documented process.

Sources: [model profiles](../../src/domain/harness-model-profile.ts), [tool discovery](../../src/server/services/agent-tool-discovery.ts), [API adapter](../../src/server/adapters/api-model.ts), [subscription adapter](../../src/server/adapters/codex-subscription.ts).

**Better direction:** offer each model an empirically suitable small core toolset and measure failures, retries, cache hits and tokens by model/tool/version. a competitor explicitly describes model-specific edit formats and error baselines. [Cursor harness engineering]([link removed]

### 9. Operational capabilities are not the same as proven end-to-end reliability

Durable execution, checkpoints and PR repair exist. Continuous deployed execution and real CI/review repair still depend on enabled infrastructure and verified live delivery. Checkpoint coverage has explicit limits around ignored/local files, large data and special repository structures. Browser tools do not by themselves establish comprehensive UI testing; debugger integration is another specialist opportunity, not the obvious cause of our basic task latency.

Sources: [workflow executor](../../src/server/jobs/model-workflow-executor.ts), [checkpoint service](../../src/server/services/session-checkpoint.ts), [PR repair](../../src/server/services/pr-repair.ts), [browser tools](../../src/server/services/api-agent-browser-tools.ts).

Do not call these missing wholesale, or infer lossless recovery and production readiness from mocked tests.

## What the measurements establish

The latest recorded ytimesy trial took **501.483 seconds**, used **670,583 input-plus-output tokens** and passed the protected assertions. The retained native-Codex control was **214.951 seconds** and **398,882 tokens**, but verification conditions were not fully identical. This does not establish a general paired ranking; it certainly does not demonstrate that ytimesy has beaten native Codex. Later receipt/preflight changes have local regression coverage, not a new live performance result.

Source: [recorded verification](../../benchmarks/evaluation/VERIFICATION-2026-10-05-SUBSCRIPTION-RERUN.md).

The missing capability here is a representative, controlled calibration loop: equal model/settings, initial state, cache conditions, task contract and final verification, with elapsed time, total/billable/cache tokens, compute cost, blinded code-quality review and recovery outcomes. One task or a feature inventory cannot justify a market-leading claim.

## Recommended improvement sequence

1. Reduce unconditional instructions and repeated discovery; preserve required guidance and source freshness.
2. Move cheap actionable feedback closer to edits; make required verification explicit and efficient.
3. Improve recoverable output retirement and provider parity before adding more summary calls.
4. Make delegation minimize measured critical-path overhead, not maximize child count.
5. Calibrate model/tool contracts, then evaluate the combined changes on multiple representative tasks.

These are the highest-confidence mechanisms to investigate. Exact performance gains remain hypotheses until measured. The goal is less repeated work and fewer repair turns while retaining isolation, evidence and quality—not a larger framework or more agents for their own sake.

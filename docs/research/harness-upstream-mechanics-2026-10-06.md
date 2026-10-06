# Upstream harness mechanics: efficiency and code quality

Checked 2026-10-06. This refresh uses first-party documentation, upstream maintainer documentation at explicit commits, and GitHub metadata. No inference, VM launch, installation, runtime benchmark, deployment, or implementation was performed. Public documentation establishes a mechanism's documented existence, not its measured benefit in ytimesy. Private decomposition, prompts, ranking, and evaluation details remain unknown unless disclosed. Compare this with the separate current-source audit; the older [gap audit](harness-gap-audit-2026-10-05.md) is a starting point, not current local-code evidence.

## Portable mechanisms

| Mechanism | Causal hypothesis for ytimesy | Necessary boundary |
| --- | --- | --- |
| Small static prompt; deferred infrequent tools/skills; stable cache prefixes | Reduces repeated input processing and avoids irrelevant instructions | Measure total and uncached input, tool errors, latency, and correctness; cache fraction alone is insufficient |
| Model-aligned edit formats and informative failures | Reduces protocol translation, malformed edits, and repair turns | Preserve path permissions, stale-content guards, and exact reviewed-change identity |
| Recoverable large output; focused lexical/symbol navigation | Reduces prompt growth and re-reading while retaining evidence | Truncation must reference complete retained output; a summary cannot recover discarded bytes |
| Selective child context and shared discovery | Keeps noisy work out of parent; can avoid duplicate exploration | Children still need sufficient constraints; snapshots must invalidate when repository/instructions change |
| Cheap diagnostics close to edits | Finds syntax/type mistakes before a long final verification cycle | Diagnostics are not behavioral tests; server startup and stale diagnostics can cost more than CLI checks |
| Overlap independent preparation/work; use completion events | Shortens critical path and polling overhead | Parallelism must exceed launch, resource contention, duplication, and integration costs |
| Durable result reuse and explicit recovery | Avoids repeating completed work after interruption | Replay requires exact inputs and safe handling of uncertain side effects |

These are hypotheses to measure, not a feature-based performance ranking.

## Cursor

**Context cost.** Its September 23 article describes trimming the system prompt by about 66%, loading infrequent built-in tools on demand, arranging stable context before cache boundaries, and numbering every tenth file-read line. It reports 7% lower aggregate token cost without quality degradation, 60% fewer static tool-description tokens, 20% fewer cold cache misses, and 1.6% fewer cache-read tokens from sparse line numbering. These are Cursor's own traffic experiments; the percentages overlap and must not be added or projected onto ytimesy. It removed strong exploration-delegation encouragement after observing coordination costs. [Token efficiency](https://cursor.com/blog/improved-token-efficiency).

**Model/tool alignment and feedback.** Cursor describes supplying OpenAI models patch edits and Anthropic models string replacement because unfamiliar formats increase reasoning and mistakes. It tunes prompts per model/version, adds transition guidance at model switches, and measures error baselines per tool/model. Switching models also loses provider/model-specific caches; switch-time summaries can lose details. This supports adapter-specific edit contracts and measured error categories, not universal claims about model families. [Harness engineering](https://cursor.com/blog/continually-improving-agent-harness).

**Recoverable observations.** Long tool results, chat history after summarization, and terminal outputs are exposed as files; the agent retrieves relevant sections. Tool descriptions are discoverable in folders. The article's 46.9% token reduction applies only to its MCP-using A/B cohort. [Dynamic discovery](https://cursor.com/blog/dynamic-context-discovery).

**Current search correction.** Search docs now describe local Instant Grep with regex/word boundaries and explicitly say Cursor does not store codebase embeddings for search. Explore can run parallel searches in a separate context and report findings. The claim that Instant Grep outperforms ripgrep is vendor-reported. Older semantic-search descriptions do not establish the current architecture. [Search](https://cursor.com/docs/agent/tools/search).

## Oh My Pi

Snapshot supplied for this refresh: [`918b9393f2ea88a3cfff7b57ecb179b723367b1c`](https://github.com/can1357/oh-my-pi/tree/918b9393f2ea88a3cfff7b57ecb179b723367b1c). These are maintainer-documented semantics at that commit, not executed tests.

**Editing.** Hashline anchors edits to recorded content snapshots and by default rejects lines not exposed by read/grep. Stale tags recover only where the snapshot chain proves a unique safe result. It supports replacement and apply-patch modes too. Writes can pass through LSP. A new parse error warns rather than automatically rolling back; multi-file preparation validates before writing, but an OS write failure can leave the earlier files changed. Thus snapshot safety and syntax feedback should not be described as atomic correctness guarantees. [Edit contract](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/tools/edit.md).

**Launch and coordination.** Batch speculative launch defaults on: each child can begin when its streamed JSON item closes. Final dispatch adopts only matching parameters; invalid/changed calls abort speculative runs, and authorization/hooks constrain eligibility. Async completion injects results into the parent. Isolation is setting-gated; ordinary children share cwd. Full child output has an artifact reference when its inline summary is truncated. Structured-output mode defaults permissive and can accept invalid output with a warning after retries. The transferable idea is reducing launch/polling delay with an explicit lifecycle, not assuming isolation or strict validation by default. [Task contract](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/tools/task.md).

**Context maintenance.** Speculative compaction defaults on and computes from a branch snapshot before the threshold, then appends newer turns. Branch-prefix, incompatible-model, and staleness changes discard the result. `shake` mechanically substitutes eligible old output with recoverable `artifact://` references without a summary-model call. Experimental notes-backed rollover is off by default and depends on model-maintained notes plus searchable retained history. Snapcompact archives text as bitmap images; no independent coding-quality benefit was verified. These alternatives have distinct information-loss and cache implications. [Compaction](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/compaction.md).

## Claude Code and Codex

**Claude Code.** Current architecture docs say older tool results are cleared before summarization, MCP schemas are deferred by default, and skill bodies load on demand. A normal child starts fresh; a fork copies parent history. Child tool traces stay outside parent context. Persistent rules still need durable instruction files because compaction can lose details. [Architecture](https://code.claude.com/docs/en/how-claude-code-works).

Installed LSP plugins add symbol navigation and edit-time diagnostics, potentially replacing repeated grep/read sequences. They require language-server binaries and do not start in Anthropic cloud sessions. This is a configured environment capability. [Code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence).

Its cost docs expose main-conversation cache misses/rebuilds and attribution to skills/tools/children; team token use scales with active instances. Preprocessing and focused context are recommended, but arbitrary filtered commands must preserve exit status and recoverable evidence. [Costs](https://code.claude.com/docs/en/costs).

**Codex.** Official docs describe parallel subagents for bounded work and summaries that keep noisy traces out of the parent, while warning about simultaneous writers and coordination overhead. This is not a sequential-only harness. Skill metadata is loaded first; the current initial catalog is capped at 2% of context, or 8,000 characters when the window is unknown. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [skills](https://learn.chatgpt.com/docs/build-skills).

OpenAI's apply-patch API has a model-understood edit protocol and explicit completed/failed receipts with actionable errors. The application's patch harness still owns path validation, application, and atomicity. This is a reusable API contract, not proof that ytimesy's own subscription loop inherits native Codex tools/prompts or that the API contract is interchangeable with its transport. [Patch tool](https://developers.openai.com/api/docs/guides/tools-apply-patch).

## Pi, Aider, and OpenCode

**Pi.** GitHub main resolved to [`2989eb581f95627618d40387ac527dc3ba061b1c`](https://github.com/earendil-works/pi/tree/2989eb581f95627618d40387ac527dc3ba061b1c) during this refresh. Its session tree preserves original JSONL entries while the active branch builds context from a summary plus retained recent messages. Skills load on demand. [Architecture](https://github.com/earendil-works/pi/blob/2989eb581f95627618d40387ac527dc3ba061b1c/packages/coding-agent/docs/how-pi-works.md).

Compaction checks projected context between tool batches; valid cut points retain tool-call/result units. Summaries track file operations and recent context. One-off summary requests disable cache writes; summarization usage is counted. This is a continuity/reference design, not evidence that its summary strategy is fastest. [Compaction](https://github.com/earendil-works/pi/blob/2989eb581f95627618d40387ac527dc3ba061b1c/packages/coding-agent/docs/compaction.md).

**Aider.** A token-budgeted symbol/signature map ranks files using dependency relationships and current chat relevance, giving structural orientation before full reads. The default map budget is 1k tokens but can expand. Edited-file lint runs automatically; project tests need `--test-cmd` and `--auto-test`. This suggests a compact discovery aid and cheap feedback, not a repository dump or compulsory whole-suite execution after each edit. [Repository map](https://aider.chat/docs/repomap.html), [lint/test](https://aider.chat/docs/usage/lint-test.html).

**OpenCode.** Current official docs set auto-compaction on, old-tool pruning off, and LSP off by default. They explicitly discuss language-server memory, synchronization, and latency costs and recommend CLI diagnostics where suitable. This is evidence for choosing diagnostics by workload. OpenCode is comparison-only; ytimesy's project policy keeps it legacy-only. [Compaction](https://opencode.ai/docs/config/#compaction), [LSP](https://opencode.ai/docs/lsp/).

## Capy, Hoplite, and Devin

**Capy.** Docs separate its server-side model loop from execution machines and overlap first inference with boot. The advertised 1–2 second snapshot restore is a vendor claim. [Machines](https://docs.capy.ai/machines).

Children begin with their prompt alone; readers can share the parent's tree, while writers receive fresh checkouts. Completion wakes the parent; intermediate progress is inspected on demand. Disjoint work runs in parallel; overlapping work stacks. The first-party docs support those boundaries, not a private optimal decomposition algorithm or native-harness identity. [Subagents](https://docs.capy.ai/subagents).

CI failure and human review events wake the owning thread; passing checks consolidate once complete. This reduces human coordination after publication but is separate from time to the first correct integrated change. [PR events](https://docs.capy.ai/pull-requests).

**Hoplite.** October 4 changelog describes prepared-context reuse when instructions/settings/skills/repository state are unchanged, reuse of checked messages, background diff refresh, repository-auth reuse with invalidation, and idle backups. These target repeated preparation and synchronous work between model requests. Steering can arrive while a shell command runs, and output survives worker restarts. These are first-party behavioral claims with no comparable timing measurements or public implementation audit. [Changelog](https://hoplite.sh/changelog).

**Devin.** Dynamic Workflows use deterministic Python orchestration and per-item pipelines without full-stage barriers. Completed agent calls replay on resume keyed by prompt/schema/execution settings; changed inputs rerun dependent work, unfinished calls restart. Children have separate VMs by default, and shared-tree writers need non-overlapping scopes. Docs recommend plain sessions for small/tightly coupled work and warn that fan-out costs more. This is the clearest documented precedent for explicit dependencies and result reuse, not proof that all coding tasks benefit from workflow orchestration. [Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows).

Browser testing follows a selected principal user flow with recordings, while the docs explicitly direct exhaustive coverage to existing suites and CI. [Testing](https://docs.devin.ai/work-with-devin/testing-and-recordings).

## What to evaluate next

After the current local-source audit, prioritize mechanics that remove a demonstrated repeated cost: model-aligned guarded edits; smaller/deferred static context with stable prefixes; recoverable output and complete lexical search; revision-bound discovery reuse; cheap diagnostics; and independent-check overlap. Speculative child launch/compaction should follow evidence that their specific waiting periods matter. Measure duplicate reads, malformed/stale edit retries, uncached input, preparation time, command/check time, child launch-to-useful-work time, and integration/review overhead at the final immutable revision. Preserve the same correctness checks and model/settings across arms. The sources do not establish a universally best harness or guarantee faster ytimesy behavior.

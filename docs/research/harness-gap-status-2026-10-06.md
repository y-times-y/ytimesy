# Harness gap status — 2026-10-06

## Conclusion

Most foundation gaps from the [October 5 audit](harness-gap-audit-2026-10-05.md) now have implementations. This is not full parity with every leading harness, and it is not evidence of superior speed, token efficiency or code quality. Source inspection, local tests, disposable cloud proofs and production operation are distinct claims.

Already implemented: isolated parallel builders, peer communication, lead supervision and reviewed integration; guarded V4A edits; deferred authorized tool discovery; scoped repository instructions and skills; retained paged command/search output; project memory and source-freshness checks; compatible native compaction and archived-history fallback; language queries; browser assertions; bounded verification and privacy-filtered metrics. See [implementation record](harness-gap-implementation-2026-10-05.md) for test boundaries.

## Remaining differences

| Area | Current ytimesy evidence | Remaining gap |
| --- | --- | --- |
| Edit-time code intelligence | `api-agent-language-tools.ts` exposes on-demand definitions/references/hover/diagnostics and read-only rename previews. Small supported edits get syntax feedback. | Not Oh My Pi's integrated LSP formatting/fresh diagnostics on writes. Language binaries and project setup still matter. |
| Interactive debugging | Shell execution and logs exist. | No dedicated DAP debugger tool was found in the active tool catalog. Oh My Pi exposes breakpoints, stepping and variable inspection. |
| Repository search | `api-agent-tools.ts` runs bounded, pageable tracked/nonignored-untracked Git regex or literal search. | No persistent indexed code search equivalent to Cursor's current Instant Grep. Archived conversation search is not a code index. |
| Context efficiency | Native-compatible compaction, encrypted recoverable history and consumed-guidance reuse exist. | No speculative background compaction or general superseded-read pruning equivalent to Oh My Pi was found in the active cloud loop. Guidance reuse is narrower. These are candidates, not automatically beneficial changes. |
| Model-specific optimization | `harness-model-profile.ts` selects family/transport-aware editing and continuation instructions. | OpenAI/Anthropic/Google/other family profiles are not empirically calibrated per-model harnesses. A generic instruction profile does not prove equivalent tool accuracy or efficiency. |
| Autonomous verification/recovery | Browser inspection, language queries, exact reviewed integration and bounded PR-repair machinery exist. | Continuous CI/review repair is not enabled with a persistent executor; a complete real CI-failure-to-repaired-PR proof remains distinct from signed delivery fixtures. Browser tooling is not proof of successful user-flow verification on arbitrary repositories. |

## Fresh upstream evidence

- Oh My Pi source pinned at `918b9393f2ea88a3cfff7b57ecb179b723367b1c`: [write-through LSP](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/packages/coding-agent/src/lsp/writethrough.ts), [DAP debugger](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/packages/coding-agent/src/tools/debug.ts), [compaction](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/docs/compaction.md), [complete-read supersession](https://github.com/can1357/oh-my-pi/blob/918b9393f2ea88a3cfff7b57ecb179b723367b1c/packages/coding-agent/src/tools/read-supersede.ts). Public source establishes mechanics, not performance superiority.
- Cursor's current [Search documentation](https://cursor.com/docs/agent/tools/search) describes local indexed Instant Grep and explicitly says it does not store codebase embeddings for search. Historical semantic-index descriptions must not be presented as its current architecture. [Cloud capabilities](https://cursor.com/docs/cloud-agent/capabilities) document computer-use evidence, event continuation and bounded CI autofix; proprietary decomposition internals remain unknown.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) can implement as well as investigate. Our subscription model loop does not inherit the native Codex harness merely by using its model. The [managed Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) is a separate surface.
- Claude Code documents [context/tool behavior](https://code.claude.com/docs/en/how-claude-code-works), [subagents](https://code.claude.com/docs/en/sub-agents) and [checkpoint limitations](https://code.claude.com/docs/en/checkpointing). Presence of our backups does not establish identical interactive rewind semantics.

## Performance boundary

The latest recorded ytimesy-only trial took 501,483 ms and used 670,583 cumulative input/output tokens while passing 562 protected assertions. The retained native control was 214,951 ms and 398,882 tokens; verification conditions were not fully identical. Subsequent foreground completion receipts and verification preflight fixes have local regression coverage, not a fresh live performance result. Neither feature completeness nor these results justify claiming we beat native Codex. [Exact evidence](../../benchmarks/evaluation/VERIFICATION-2026-10-05-SUBSCRIPTION-RERUN.md).

This turn performed source/document research and added this note only. No model inference, VM provisioning, deployment, schema changes, commit or push occurred.

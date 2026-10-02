# API prompt caching

Updated 2026-10-01. Prompt caching reuses provider-side KV computation; it does not shorten prompts, cache answers, reduce context-window occupancy, or guarantee a cache hit. Output remains generated normally. Cache-write charges can outweigh savings on one-off requests.

## Implementation

- Native Anthropic requests to `api.anthropic.com` use the installed SDK's top-level ephemeral cache control, with its default short TTL. This advances the cache boundary across model/tool steps.
- Official OpenAI requests receive an opaque owner/connection/chat-scoped cache key. Native implicit caching remains provider-managed.
- Official xAI requests receive a stable `x-grok-conv-id`. Official Meta and Mistral compatible requests receive `prompt_cache_key`.
- Official OpenRouter requests receive a stable `x-session-id`. A scoped fetch adapter adds one ephemeral content-block breakpoint to the latest eligible user/assistant text for Claude, Gemini, and the explicitly documented Qwen model IDs. It preserves tools, images, text and caller-provided markers. Explicit block markers avoid narrowing Claude routing to Anthropic's own endpoint. Tool-result-only tails beyond that boundary are not explicitly cached by this adapter.
- Automatic-only providers need no invented settings. Unknown/custom endpoints are left unchanged; model authorship does not establish hosting-endpoint capabilities. No paid fallback, provider-order override, extended retention, or response caching is introduced.
- Usage is accumulated after each completed inference step, including compaction requests. Only allowlisted numeric totals are persisted on the current user prompt as `apiUsage` inside existing JSONB records. Checkpoint and completion paths retain it, including failed turns. Provider raw bodies, credentials, and prompt contents are not added to analytics.
- Cache-read/write and ordinary input counts remain `null` when unavailable. OpenRouter's raw cache-write detail and DeepSeek's native hit/miss fields supplement SDK normalization. This is usage accounting, not a dollar-cost estimator or a context-window meter. Existing conservative token safety limits remain unchanged.

No database migration or new dependency is required. Codex's native subscription loop is unchanged.

## Verification

Automated tests exercise real SDK request serialization using a fake transport, gateway preservation, tenant-scoped key stability, unknown endpoints, usage normalization, accumulation and durable checkpoint/failed-turn storage. These are not live provider calls.

The bounded live proof used the existing saved OpenRouter connection, synthetic code fixtures and no VM. Claude Haiku 4.5 reported 6,933 input tokens on both requests; the second reported 6,931 cache-read tokens. Cache-write counts were not supplied. The proof reserved $0.096332 using a conservative byte-based bound under the authorized $0.10 cap; this is not the actual billed amount. The Gemini leg was skipped because it exceeded the remaining conservative allowance. This proves a repeated-prompt cache hit through the application's model adapter, not cache hits for every model, chat, or deployed worker.

Run `CACHE_PROOF_SPEND_CAP=0.10 node --env-file=.env --import tsx scripts/prove-api-prompt-cache.ts` only with fresh spending authorization. The proof refuses ambiguous saved connections, never prints credentials and bounds both requests before dispatch.

## Sources

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Google context caching](https://ai.google.dev/gemini-api/docs/caching)
- [OpenRouter caching and sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [xAI cache behavior](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works)
- [Meta prompt caching](https://dev.meta.ai/docs/prompt-caching)
- [Mistral prompt caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Z.ai context caching](https://docs.z.ai/guides/capabilities/cache)

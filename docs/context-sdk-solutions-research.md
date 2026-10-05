# Existing SDK solutions for reasoning continuity and compaction

Research checked 2026-10-04 against installed source and primary documentation. No inference, dependency changes, implementation, or deployment was performed. Documentation was read with agent-browser; package publication metadata was checked with npm.

## Conclusion

Reuse the installed Vercel AI SDK providers for provider-native compaction. Use the dedicated OpenRouter provider when the workflow needs OpenRouter Chat Completions reasoning details. Neither a generic summarizer nor a database checkpoint can compact encrypted reasoning itself. Native compaction is a provider operation; SDKs expose and replay its artifacts.

There is a documented OpenRouter Anthropic Messages compaction request shape. Its OpenAPI includes `context_management.edits` with `compact_20260112`, and compaction response blocks, streaming deltas, usage iterations, and the `compaction` stop reason. This is stronger evidence than finding no compaction page in the documentation index, but it is still schema evidence, not a live proof that the chosen routed model and provider honor it.

## Exact compatibility with this repository

| Package | Repository pin | Inspected capability |
| --- | --- | --- |
| `ai` | 7.0.118 | Provider metadata and model message processing; pruning rather than a universal native compactor |
| `@ai-sdk/openai` | 4.0.78 | Responses `contextManagement`, explicit `compactionTrigger`, encrypted reasoning replay, `openai.compaction` custom parts |
| `@ai-sdk/anthropic` | 4.0.65 | Threshold compaction, on-demand signed compaction, thinking and compaction replay |
| `@ai-sdk/openai-compatible` | 3.0.57 | Reasoning text handling; inspected chat source does not implement OpenRouter `reasoning_details` fidelity |
| `@ai-sdk/google` | 4.0.82 | Installed; not audited in this scoped comparison |
| `@openrouter/ai-sdk-provider` | Not installed | npm publication 3.1.0: `ai: ^7.0.0`, `zod: ^3.25.76 \|\| ^4.1.8`, Node >=22, Apache-2.0 |
| LangChain/LangGraph and Claude Agent SDK | Not installed | Alternatives evaluated from primary docs, not verified repository integrations |

The dedicated OpenRouter provider's published peer ranges match the repository's `ai` 7.0.118 and `zod` 4.6.4. Node compatibility must be checked on the actual execution host before installation. Upstream main also reports 3.1.0; its inspected implementation may drift independently of the published package, so treat source findings as an integration direction until the published artifact is tested.

## Vercel AI SDK: native provider adapters already exist

The installed OpenAI Responses adapter exposes `contextManagement: [{ type: 'compaction', compactThreshold }]` and maps it to `context_management`. It also exposes `compactionTrigger: true`, appending a terminal `compaction_trigger` input item. Returned compaction appears as a custom `openai.compaction` part with provider metadata containing `itemId` and `encryptedContent`. Its input conversion can replay the encrypted artifact or refer to stored items. These are provider-native operations; the SDK does not decrypt or compress the artifact itself. Endpoint/model support remains conditional. [OpenAI provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/openai).

Installed source: `node_modules/@ai-sdk/openai/src/responses/openai-responses-language-model-options.ts`, `openai-responses-language-model.ts`, `convert-to-openai-responses-input.ts`, and `openai-responses-provider-metadata.ts` under the same directory.

The installed Anthropic adapter supports both `contextManagement.edits` using `compact_20260112` and `compaction: { type: 'summarize', instructions? }`. On-demand compaction adds `compact-2026-09-04` automatically. Anthropic returns readable summary text with an opaque signature; the adapter preserves that signature through response metadata/options. This is a signed summary, not decrypted hidden reasoning. [Anthropic provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand).

Continuation requires exactly one signed compaction block first in `messages`, unchanged text/signature, removal of summarized messages, and consistent system/tools when retaining later thinking. Resolve unfinished tool calls before on-demand compaction. Check `rawFinishReason === 'compaction'`; a successful HTTP response can still contain no successful summary. The SDK's response messages carry the necessary metadata, but application serialization must preserve it. Installed source: `anthropic-language-model-options.ts`, `anthropic-language-model.ts`, and `convert-to-anthropic-prompt.ts` under `node_modules/@ai-sdk/anthropic/src/`.

The generic `pruneMessages` utility deletes selected reasoning/tool/message content. It is not a native opaque-state compactor. Installed source: `node_modules/ai/src/generate-text/prune-messages.ts`. Dropping signed blocks or altering their surrounding bound prefix can break reasoning continuation even if visible answer text survives.

## OpenRouter: structured reasoning preservation and compaction are separate

OpenRouter documents replaying `message.reasoning_details` for encrypted or summarized reasoning, including consecutive blocks in their original sequence. That is a normalized transport format, not evidence that encrypted payloads are interchangeable between model families or that an arbitrary shortened transcript preserves their validity. [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

The maintained dedicated provider reads, accumulates, and replays `reasoning_details`. Its conversion handles message metadata, reasoning/tool-call metadata, duplicate reasoning IDs, required empty arrays, and missing signatures. This directly addresses protocol details absent from the generic compatible adapter. It does not solve prefix binding invalidated by custom transcript summaries. Source: [chat implementation](https://github.com/OpenRouterTeam/ai-sdk-provider/blob/main/src/chat/index.ts), [input conversion](https://github.com/OpenRouterTeam/ai-sdk-provider/blob/main/src/chat/convert-to-openrouter-chat-messages.ts), [package manifest](https://github.com/OpenRouterTeam/ai-sdk-provider/blob/main/package.json).

OpenRouter's Responses API explicitly requires stateless operation: `store: true` and non-null `previous_response_id` are rejected. Its create-response schema includes `compaction` and `context_compaction` input artifacts, but this audit found no documented `context_management` trigger or dedicated `/responses/compact` operation in the retrieved Responses docs/index. Acceptance of a compaction item is not proof that the service creates it or that every provider consumes it. [Responses overview](https://openrouter.ai/docs/api_reference/responses/overview), [Create a response schema](https://openrouter.ai/docs/api/api-reference/responses/create-a-response).

OpenRouter's **Anthropic Messages** request schema does include `context_management.edits` with `compact_20260112`, `instructions`, `pause_after_compaction`, and input-token trigger, plus corresponding response block/delta/usage shapes. This is a plausible native threshold-compaction route to verify. The inspected request schema did not expose Anthropic's separate on-demand `compaction: { type: 'summarize' }` option; do not infer support for that newer API from threshold support. [Create a message schema](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message).

The dedicated OpenRouter AI SDK provider advertises Chat Completions and completion APIs; installing it does not automatically move the app to Anthropic Messages. A separate adapter or an explicitly configured Anthropic provider base URL would need compatibility verification before claiming Messages pass-through works. In particular, check beta header forwarding, model/provider availability, prefix binding, signed block fidelity, streaming parsing, and repeated compaction.

## LangChain/LangGraph

LangChain's maintained JavaScript `summarizationMiddleware` asks a chat model to summarize earlier messages and retains a configured recent tail. `trimMessages` removes messages. LangGraph checkpointers persist conversation/graph state and permit restart; persistence does not reduce the provider's active context window. These facilities are appropriate for visible transcript summarization and durable state, but there is no evidence in the inspected guide that they compact opaque provider reasoning or repair signatures after prefix changes. [Short-term memory](https://docs.langchain.com/oss/javascript/langchain/short-term-memory).

Adding LangGraph solely for compaction would duplicate ytimesy's existing durable orchestration and state ownership without solving the provider-specific binding problem. Reassess only if adopting its graph execution model is independently desirable.

## Claude Agent SDK

The Agent SDK embeds Claude Code's autonomous loop, automatically summarizes older history near the context limit, exposes `compact_boundary`, offers `PreCompact` hooks, and accepts `/compact` as an SDK prompt. Sessions persist conversation history on disk and can resume or fork. Those are genuine maintained harness features; the documentation describes summary replacement, not a model-independent opaque reasoning compression API. [Agent loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop), [Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions).

It is a broader runtime choice than a compaction utility. It does not plug directly into the existing Vercel model loop, and subscription/auth permissions need their own review. Its existence is not authorization to change ytimesy's selected unmodified Claude Code runtime adapter or billing path.

## Recommended next proof

1. Keep Vercel AI SDK as the model-loop abstraction. Verify native OpenAI and Anthropic compaction through their already installed adapters, with full provider metadata persisted.
2. For OpenRouter Chat Completions, evaluate dedicated provider 3.1.0 in a bounded protocol test covering streaming encrypted details, parallel tool calls, empty reasoning arrays, restart/reload, and metadata round-tripping. It addresses preservation, not arbitrary compaction.
3. If native Claude compaction through OpenRouter is required, test the documented Anthropic Messages threshold route with the actual available model/provider. Do not claim support from schema alone.
4. Retain visible transcript summaries and retrieval as separate fallback mechanisms. If a fallback changes a bound prefix, treat it as a reasoning reset and use the provider's documented mismatch behavior instead of presenting old signatures as valid continuity.

No live inference was run. Installed code confirms adapter support; current docs confirm request/response contracts; npm confirms publication and peer ranges. This research does not prove quality after repeated compaction, exact provider token accounting, live OpenRouter native compaction, or deployment compatibility.

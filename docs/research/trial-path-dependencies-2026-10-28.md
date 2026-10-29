# Trial-path dependencies and silent fallbacks (2026-10-28)

Scope: the code a Harbor bridge v2 trial runs (evals/harbor_v2/*, src/server/services/api-agent-*.ts, model-agent-loop.ts, src/server/adapters/model-context.ts, browse-models.ts, model-catalog.ts, prompt cache settings, tool setup). Context: on 2026-10-27 a catalog timeout gave GPT-6 Astra on Bedrock a guessed 128K window, and 62 of ~304 TB4 trials died. Line numbers are on branch run-safety after the fixes.

## Outside network calls other than the model API

- src/server/adapters/browse-models.ts:15. GET openrouter.ai/api/v1/models (8 s timeout). On failure it threw and the window became the 128K guess. FIXED: a routed model's window and image input come from src/domain/model-context-windows.ts before any catalog request, so the Bedrock, openai-api and OpenRouter routes for listed models make no catalog call.
- src/server/adapters/model-context.ts:172. GET openrouter.ai/api/v1/models/<id>/endpoints, OpenRouter connections only. A failure leaves the window unknown. Fine: never reached for a listed model (table first). For an unlisted model it now logs a warning naming the model.
- src/server/adapters/model-context.ts:61-72. GET <provider>/models/<id> on api.anthropic.com and Gemini, using the owner's key. This is the model provider's own API. FIXED: on failure it logs "Model context metadata unavailable." and uses the checked-in window. It is not used on the Bedrock routes.
- src/server/adapters/model-context.ts:190. GET <baseUrl>/models for compatible endpoints, using the owner's key. That is the provider's own endpoint. On failure the window is unknown and one warning is logged. Fine: no benchmark route uses it, and the bridge refuses an unknown window (B).
- src/server/adapters/model-context.ts:127 (catalogImageInput -> browseModels). Reads image input from the public catalog. On failure it was undefined, which the runtime treats as images allowed. FIXED for routed models (table first). Fine otherwise: undefined behaves like "images allowed".
- src/server/adapters/codex-subscription.ts:266. GET codex/models on the Codex backend (codex-subscription route only). This is the model provider. If it fails, preparation fails loudly. Fine.
- evals/harbor_v2/harness.ts:266. The web_fetch tool when variant fetch=on. The agent itself fetches public URLs from the bridge host. This is intended agent behaviour (off by default), and failures go back to the model as tool errors. Fine.
- evals/harbor_v2/env-snapshot.ts:137. curl https://pypi.org from inside the task container (envSnapshot=on only). It probes the sandbox's network, not the harness's. Failure reports net=failed in the snapshot. Fine.
- evals/harbor_v2/bedrock.ts:227. Reads ~/.aws/credentials, which is local and not a network call. On failure the text is empty and bedrockCredentials then throws naming the source. Fine.
- None in api-prompt-cache.ts, api-model.ts, model-catalog.ts discovery (not on the trial path) or model-compaction.ts beyond the model API. The Bedrock OpenAI compaction (/responses/compact) is the model API, signed and guarded.

## Catches that continue with a guessed default

- src/server/adapters/model-context.ts:106. Metadata failure was swallowed with `catch {}` and the window stayed unknown, so the budget silently used 128K. FIXED (dangerous: it changed budgets): the error name is logged, the checked-in window is used, and a remaining unknown window logs "Model context window unknown; the run uses the unknown-window budget." with the model id and 128000. The bridge now refuses an unknown window at config time (evals/harbor_v2/config.ts, Bedrock models) and at runtime (runtime.ts requireContextWindow).
- src/server/adapters/model-context.ts:167. browseModels().catch(() => []), with the same effect as above. FIXED by the table and the warning.
- src/server/adapters/browse-models.ts:30. Serves the stale cached catalog on failure. Fine: stale limits are better than none, and routed models no longer read it.
- src/server/services/api-agent-context.ts (historySplit). On whole-turns routes, one oversized active turn threw "cannot be safely compacted". Not a silent fallback, but it was fatal. FIXED (C): completed steps retire.
- src/server/services/model-agent-loop.ts onError and the "error" part. A plain Error from compaction or step preparation was logged as "Model provider failed {code:'unknown'}" and surfaced as a provider failure. FIXED (D): HarnessRuntimeFailure, "Context compaction failed: <redacted message>".
- src/server/services/model-agent-loop.ts:787. Compaction state snapshot failure: `catch {}` and continue without a snapshot. That changes the prompt, but the snapshot is optional by design. FIXED (now logged); behaviour unchanged.
- src/server/services/model-agent-loop.ts:996 and 1024. Archive or compaction failure at a model switch at a round's start continues on the uncompacted history. Fine: already logged, and the provider-neutral history is valid.
- src/server/services/model-agent-loop.ts:1150. NEW: native compaction failure on a route with compactFallback (Bedrock GPT) falls back to the harness's own summary. It logs a classification plus a redacted message. Only runtimes that opt in.
- src/server/services/model-agent-loop.ts:1277 and 1330. Metrics hooks. Fine: observability only.
- src/server/services/background-history-compaction.ts:45. Speculative background compaction failure keeps the history. FIXED (now logged by error name); behaviour unchanged. The foreground compaction still runs when needed.
- src/server/services/background-history-compaction.ts:75. A failed archive rejects the speculative checkpoint. Fine: the conservative choice.
- evals/harbor_v2/helpers.ts:201. A helper child's error became {outcome: "failed", report: ""} with nothing logged, so the cause was hidden the way this incident's was. FIXED: the error is logged to the trial log.
- evals/harbor_v2/children.ts:131 and 254. changedFiles().catch(() => []). A handoff or round report omits the changed-file list. Fine: it is a note, and the child reads the workspace itself.
- evals/harbor_v2/children.ts:183. A classifier failure falls back to the default decision. Fine: recorded in the trace with the error text.
- evals/harbor_v2/search-tool.ts:34. A web_search failure returns "Search failed: ..." to the model. Fine: visible to the model and the trace.
- evals/harbor_v2/trial.ts:665. Tail of a checker log: "" on failure. Fine: an optional context excerpt.
- evals/harbor_v2/trial.ts:1149. A goal compaction snapshot failure gives undefined. Fine: the goal note is still added.
- evals/harbor_v2/env-snapshot.ts:178. The probe failure returns null. Fine: the caller logs that the snapshot is missing (trial.ts ~1331).
- evals/harbor_v2/atif.ts:408. A tool schema that cannot serialize gets no parameters in ATIF. Fine: the trace only.
- evals/harbor_v2/transport-guard.ts:52, 77, 122 and 278. Unparseable URL or event gives null (no special handling). Fine: parsing helpers.
- evals/harbor_v2/transport-guard.ts (maxAttempts). A stream cut before its terminal event is re-sent identically below the spend guard: one guarded request can be two provider requests. Fine for behaviour. Note for cost: a cut stream may still be billed by the provider.
- evals/harbor_v2/transport-guard.ts:323 and 331. Failures writing the transport log. Fine: logging only.
- evals/harbor_v2/runtime.ts:353 (contextManagementFallback). NEW: if Bedrock refuses context_management (400/404/422 naming it), the request is re-sent without it once and later requests omit it, with a warning. Explicit and logged.
- src/server/adapters/api-prompt-cache.ts:63-100. An unparseable body is sent without cache markers. Fine: cost only, never content.

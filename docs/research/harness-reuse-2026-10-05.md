# Harness reuse evidence — 2026-10-05

Scope: inspected installed `ai@7.0.118` / `@ai-sdk/openai@4.0.78` source and first-party documentation/package metadata. No dependencies installed, inference requested, or VMs started. Recommendations below require implementation checks; subscription endpoint acceptance is not proven by source inspection.

## Apply patch: reuse the provider adapter and the official parser

Use `openai.tools.applyPatch({ execute })` with the tool key **`apply_patch`**. The installed adapter supplies operation validation and Responses API call/output conversion, but does not interpret or apply diffs. Its input is `{ callId, operation }`; operations are `create_file`, `update_file`, or `delete_file`; output is `{ status: 'completed' | 'failed', output?: string }`. Despite a local type comment calling these unified diffs, OpenAI specifies **headerless V4A**, so `git apply` and generic unified-diff libraries are not direct substitutes. [AI SDK guide](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [OpenAI apply-patch guide](https://developers.openai.com/api/docs/guides/tools-apply-patch).

The reusable interpreter is **`applyDiff` from `@openai/agents-core/utils`**. Npm currently publishes version **0.19.0**, MIT licensed, maintained in OpenAI's Agents JS repository. OpenAI's apply-patch guide explicitly points to this implementation. API:

```ts
import { applyDiff } from '@openai/agents-core/utils';

const created = applyDiff('', operation.diff, 'create');
const updated = applyDiff(currentText, operation.diff);
```

It is a synchronous pure string transformation: no filesystem, credential, provider, or approval access. Source handles context anchors, sections, EOF context, whitespace fallback, overlapping chunks, and CRLF updates. Use the public `/utils` subpath: importing the root adds a default trace processor in its module body. The `/utils` export is present in the published package and re-exports `applyDiff`. [Published npm metadata](https://registry.npmjs.org/@openai%2Fagents-core/latest), [published utils entry](https://unpkg.com/@openai/agents-core@0.19.0/dist/utils/index.mjs), [parser source](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/utils/applyDiff.ts), [MIT license](https://github.com/openai/openai-agents-js/blob/main/LICENSE).

Recommendation: pin the maintained dependency and keep only product-specific VM file operations/path restrictions in ytimesy. Feed trusted library code repository content as data. Never resolve executable parser code from an untrusted repository's `node_modules`; use the server dependency or a trusted bundle outside the checkout. Retain the existing repository-relative path, `.git`, symlink, size, and read/write authority guards; the parser cannot enforce those. Creation must reject existing targets and deletion must not follow symlinks. Context mismatch should return failed with a concise error. The parser deliberately allows whitespace fallback and recognizes section terminators: validate operation-envelope expectations rather than assuming every trailing token is rejected. Verify create newline behavior, CRLF/EOF updates, repeated context, malformed patches, path escapes, and concurrent modification at integration time.

Alternative: OpenAI's Rust `codex-rs/apply-patch` implements full Codex patch envelopes, but shipping/building a native binary is a larger deployment boundary than using the published TS pure transform. The OpenAI Agents Python parser also requires another runtime. Neither is the smallest fit for this TypeScript loop. [Codex implementation](https://github.com/openai/codex/tree/main/codex-rs/apply-patch), [Python implementation](https://github.com/openai/openai-agents-python/blob/main/src/agents/apply_diff.py).

Local evidence: `node_modules/@ai-sdk/openai/src/tool/apply-patch.ts`; `src/responses/openai-responses-prepare-tools.ts`; `src/responses/convert-to-openai-responses-input.ts`. Output conversion in the last file checks `part.toolName === 'apply_patch'` literally; renaming the tool risks generic function-output replay instead of `apply_patch_call_output`.

## Tool discovery: SDK reuse plus durable state

Prefer **`toolSearch()` from `ai`**, paired with `deferLoading: true` on optional tools. This is an SDK-executed ordinary function tool, independent of OpenAI's hosted search. Installed source tokenizes names/descriptions, scores name matches twice description matches, returns up to five tools, and exposes matches on the next model step. It binds execution within each generation, so calling its raw `execute` directly throws.

Important durable boundary: `createToolSearchState` initializes a fresh `Set<string>` for each `generateText`/`streamText` invocation. It never scans replayed messages to reconstruct discovered tools. Search candidates also come from the already-filtered `activeTools`; a deferred tool removed by that filter cannot be discovered. Persist names returned by search alongside the checkpoint/messages, or deterministically recover known names from persisted search results. On resume, mark known tools `deferLoading: false` when reconstructing the tool registry, keep other tools deferred, and ensure `activeTools` includes permitted discoverable candidates. Merely putting a known tool into `activeTools` does not overcome the fresh discovery set.

Provider **`openai.tools.toolSearch()`** is different: sends the native `tool_search` wire tool, defaults to hosted execution, optionally accepts `execution: 'client'` with a custom lookup executor, and has Responses API search-item replay support. It does not make a durable application registry unnecessary. Prefer generic SDK search for this harness until subscription/custom-endpoint hosted search support is separately proven. Source inspection confirms `createOpenAI` accepts `baseURL` and `fetch`; this does not establish which native tools a subscription endpoint accepts.

Local evidence: `node_modules/ai/src/tool-search/tool-search.ts`; `prepare-tool-search.ts`; `generate-text/generate-text.ts` (active-tool filtering before search binding); `node_modules/@ai-sdk/openai/src/tool/tool-search.ts`; `openai-provider.ts`.

## Telemetry: reuse SDK hooks, keep recording explicit

AI SDK 7 exposes `telemetry` options and per-call `integrations` for model/tool lifecycle events. An explicitly supplied per-call integration overrides global integrations. `isEnabled: false` disables dispatcher work; input/output recording defaults to enabled when integrations are active, so set `recordInputs: false`, `recordOutputs: false`, and omit sensitive context inclusion. Runtime/tool context inclusion is opt-in by key. Preserve existing durable trace/usage records; telemetry callbacks are observability hooks, not a recovery journal or transactional checkpoint.

Local evidence: `node_modules/ai/src/telemetry/telemetry-options.ts`; `create-telemetry-dispatcher.ts`. Use the installed version's actual `telemetry` API, not older `experimental_telemetry` examples. No external telemetry destination was configured or contacted by this research.

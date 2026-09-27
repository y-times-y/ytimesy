# Model API connections: implementation status

The connection layer and direct API runtime are integrated into this working tree.
The three database migrations were applied to the linked database on 2026-09-27.
This is not a production deployment or a completed live end-to-end verification.

The model-picker redesign is integrated into this working tree: model search,
local favorites, per-model reasoning/Fast controls, and the Claude Code API-key
entry. That existing CLI route uses owner-scoped `user_harness_api_key` records;
the direct-API connections below use their own runtime identity rather than the
Codex subscription adapter.

## Implemented

- Owner-scoped API connections for OpenAI, Anthropic, Google Gemini, OpenRouter,
  and public HTTPS OpenAI-compatible endpoints.
- Encrypted credentials using the existing token vault. Ciphertext binds the key
  to both its user and connection. Public queries do not select credentials.
- Provider model discovery, including paginated Anthropic and Google catalogs.
  Listing a model does not establish coding or tool-call compatibility.
- Explicit, billable streaming-tool verification per model. A replaced key resets
  verification. A stale probe cannot verify a replacement credential.
- Settings UI for adding, replacing, verifying, and disconnecting connections.
- SDK-backed API loop with text/reasoning deltas, tool calls/results, per-step
  checkpoints, cancellation, and bounded steps, connected to the chat service
  and durable worker. API turns freeze the selected connection/model at enqueue.
- Owner-checked turn enqueue, one active API turn per session, worker leases,
  and failure instead of automatic replay after uncertain worker loss.
- VM progress snapshots reuse the existing streaming transport. Terminal status
  is written after completion or failure, with database state authoritative.
- Token reservations are shared across a root and its children, with an account
  ceiling. These conservative usage limits are not monetary spending caps.
- No automatic retry or fallback to another model, subscription, or API account.
- Endpoint transport rejects private/reserved addresses at connection time,
  mixed public/private DNS results, origin changes, and HTTP redirects.
- Provider-specific SDK dependencies are pinned. Existing CLI runtimes are unchanged.

## Remaining validation and limitations

1. Validate runtime switching in both directions, including connecting a CLI
   before sending, transcript preservation, and native tool-history continuity.
2. Verify cancellation while VM tools are executing, read-only delegation,
   parent wake-up after failure, and stale-progress handling between turns.
3. The current context-size guard fails explicitly; automatic compaction is not
   implemented. Token quotas do not replace provider pricing or dollar budgets.
4. Validate the authenticated settings flow in a browser, then run a real coding
   task with an explicitly selected connection and authorized API credit.

Migration tests passed against a disposable database before applying exactly the
three reviewed migrations in one transaction and recording their versions in
Supabase migration history. Live checks confirmed RLS on all four new tables.
No paid inference or VM creation was performed during that migration validation.
SDK stream fixtures prove normalization and tool-loop behavior, not live provider
compatibility or benchmark performance.

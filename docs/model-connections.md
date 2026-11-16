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

## Grok plan refusals are retried (2026-11-08)

A Grok turn whose request got a 403 used to set the connection to
`not-eligible` for good: the next turns tried it, were refused by our own
status check, and ran on the fallback model, with Settings still showing
"connected". Production had one such row stuck for a day after a single 403 on
step 48 of a long turn. Now a 403 is recorded as `not-eligible` only when its
body names the plan or subscription (`xaiForbiddenVerdict`); any other 403
fails that request and records nothing (the body is logged as
`xAI refused a Grok request.`). A `not-eligible` row is tried again after 10
minutes (`XAI_REFUSAL_COOLDOWN_MS`) and returns to `ready` when a request
succeeds. A 401 after a forced refresh still means `reconnect` and waits for
the user.

## Grok plan: limit 403s, sign-in prompts and refresh (2026-11-16)

Report: "the Grok connection works, but the next day I have to log in again."
Production had the owner's row at `not-eligible` since 2026-11-13 04:16 UTC;
Settings showed that status with a **Reconnect** button and the text "...then
reconnect", and the chat's failover notice said "Grok plan needs reconnecting
in Settings", so a refused request looked like an expired sign-in.

- xAI answers a spent plan with a 403 that also names the subscription:
  "You have either run out of available resources or do not have an active
  Grok subscription. Manage your subscription at https://grok.com/?_s=usage
  ..." (Hermes #26847), or `personal-team-blocked:spending-limit` "You have run
  out of credits or need a Grok subscription" (CLIProxyAPI #5335). The old
  classifier matched `subscri|supergrok|upgrade` and recorded those as
  `not-eligible`. `xaiForbiddenVerdict` now reads limit wording first and
  returns `usage-limit` (recorded nowhere; the turn fails over with "Grok
  plan is out of usage"); `not-eligible` needs an explicit refusal ("does not
  include", "not eligible", "requires a SuperGrok ... subscription").
- A `not-eligible` refusal fails the turn over with the new reason
  `plan-refused` ("SuperGrok refused this request"); only a rejected sign-in
  (`reconnect`) keeps `plan-access` and "needs reconnecting in Settings".
- Settings shows a `not-eligible` row as **Retrying** with Sign out, not a
  sign-in prompt: the row is tried again after `XAI_REFUSAL_COOLDOWN_MS` and the
  next request that works sets it back to `ready` (also within the same turn).
- `reconnect` is written only when the token endpoint answers 400/401 with
  `invalid_grant`, `invalid_client` or `unauthorized_client`
  (`xaiRefreshRejected`). A 403 or HTML from auth.x.ai, another OAuth error, a
  5xx, or a 401 from api.x.ai on a token that was just refreshed fail the
  request as `unavailable` and keep the sign-in.
- xAI rotates refresh tokens on every use and rejects a spent one (OpenCode
  #37059, OpenChamber #4364, where a quota poller that refreshed without
  saving caused a re-login "every morning"); access tokens live about 6 h. A
  401 refresh now only spends the refresh token if the stored access token is
  the one that was rejected, and a failure to save a rotated pair is logged
  as `A rotated Grok sign-in could not be saved.`
- Every status change logs `Grok plan connection status changed.` with
  from/to, cause, HTTP status and a redacted body snippet (`xaiLogSnippet`);
  a sign-in logs which status it replaced.

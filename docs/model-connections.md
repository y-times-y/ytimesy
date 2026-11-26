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

## Gemini 4 Neon (added 2026-11-24)

`gemini-4-neon` (OpenRouter `google/gemini-4-neon`), GA 2026-11-18 per Google's model page: 1,048,576-token context, text/image/audio/video/PDF input, function calling, $3 / $15 per 1M tokens (cache read $0.15; priority 1.8x). Frontier failover tier, between Carbon and Argon. Like every listed model it shows only on a connection (Google key or OpenRouter) whose discovered list includes it. Not verified against the live API (no key in this environment).

## Retired from the pickers 2026-11-17

Every GPT-5 variant (`gpt-5`, `gpt-5.x`, `-codex`, mini, nano; bare or
`openai/`-prefixed) and Claude Fable 5.1 are no longer offered in any model
picker. `isRetiredModel` (`src/domain/retired-model.ts`) is the one predicate;
list builders use it (`OFFERED_API_MODELS`, `connectionModels`,
`CLAUDE_CODE_MODELS`, the Codex subscription catalog and its browser saved copy (filtered on read), the saved agent catalog,
`recentModelGenerations`, `sessionModelsFromListed`). Kept on purpose, so chats
and usage history from before the retirement still work: pricing, context
windows (including the `gpt-5.x` rule in `model-context.ts`), the failover
equivalence maps, the `API_MODEL_LIST` entry for Fable 5.1 (label, speeds,
long-context tier), and server acceptance of the ids. **Old chats**: a chat on a
retired model keeps sending on the same id (no successor, no rewrite): the
composer keeps the chat's own model, the send guard and the server's send paths
accept it (`includeRetired`), and pricing, context and failover still resolve.
The picker does not list it and shows no retired badge (the picker design is
untouched); choosing another model replaces it. GPT-6.x, Fable 5.2, Mythos and
Opus/Sonnet/Haiku are unaffected. Not covered: models from a custom endpoint.

## Codex model list: saved per account, re-checked on real triggers

The only authority on what a ChatGPT plan may use is ChatGPT's live catalog (`codex/models?client_version=<pinned CLI>`, read in src/server/adapters/codex-subscription.ts). A model OpenAI has not rolled out to an account must not show for it, and every read costs a request, so the browser keeps the user's own copy and the developers control when it is asked again.

- **Saved copy**: localStorage under `ytimesy:codex-catalog:<user>:<PINNED_CODEX_CLI_VERSION>:<CODEX_CATALOG_EPOCH>` with `savedAt` (src/features/sessions/codex-catalog-store.ts; defensive parse, bounded size, corrupt data ignored). The picker, its search and the composer read it with no request; hover and focus never fetch the list.
- **Re-check only on a real trigger**: (a) no copy for the current key (first visit on a device, storage cleared, pin changed, epoch bumped): one read on the next visit; (b) a Codex turn fails because the model is unavailable to the plan (failure text `MODEL_UNAVAILABLE_FAILURE`, src/domain/codex-model-unavailable.ts): the copy is dropped and the list is read once, bypassing the server cache; (c) the "Refresh model list" button in the Codex section header, once per 60 s, bypassing the server cache (how a person picks up a rollout that reached their account after the last check); (d) safety net: a copy older than 48 h (`CODEX_CATALOG_REFRESH_AFTER_MS`) is re-read once in the background at the next mount.
- **Server**: the per-user catalog is fresh for 15 min and served stale for up to 6 h while it refreshes; one load in flight per user; `force` skips the fresh copy; `codex.catalog` logs once per actual load.
- **Discovery**: `codex.response_headers` logs the header names (never values) of a /responses answer at most once an hour per isolate, to learn whether ChatGPT sends a model-list version header (the Codex CLI relies on `x-models-etag`). Nothing acts on it yet.

### When OpenAI launches a Codex model

1. Bump `CODEX_CATALOG_EPOCH` in src/domain/codex-catalog-epoch.ts. Every user then re-checks their own account once on their next visit (and only accounts that were rolled out the model will list it).
2. Add the model to the places that know new OpenAI models: api-model-list, model-pricing, model-context-windows and model-failover (src/domain).
3. Retiring a model is the same bump: filter the id (`isRetiredModel`) and bump the epoch so saved copies refresh (epoch 2: GPT-5 family retired).
4. Changing the pinned Codex CLI version (`PINNED_CODEX_CLI_VERSION`) also changes the key, so it needs no separate bump.

## Several subscription accounts per provider (2026-11-26)

A person can connect up to five ChatGPT (Codex) accounts and five Claude plans
and the platform uses them in order, moving to the next when one is spent.

- **Storage.** A provider's existing connection row (`agent_account` for Codex,
  `claude_subscription` for Claude) is the *slot*: the account in use. Every
  other account waits in `subscription_account` (sealed per account with the
  binding `subscription-account:<id>` + user; never sent to a box or logged).
  A user with one account has no extra row and nothing new runs for them.
  Each account has its own id (`account_id`, travels with it), a name, an
  order (`priority`), `last_used_at`, and limit state (`limited_until`).
- **Switching** (`src/server/adapters/subscription-accounts.ts`) moves an
  account's whole state into the slot and the old one out, in one transaction
  under the row lock token refresh already takes, so the relay, the Claude
  proxy and the runner boxes keep reading one place. Pure rules (choosing,
  limits, reset times) are in `src/domain/subscription-accounts.ts`.
- **Before a turn** (`prepareTurnAccount`): the chat's pin, else Auto (priority
  order, staying on the account in use while it is as good as any). Skipped
  while another of the user's turns runs, so no running turn changes account
  under itself; on any doubt the turn uses the account in the slot.
- **On a plan limit** (`rotateAfterLimit`, called from the step-failure path in
  `api-turn.ts` before provider failover): the account rests until the reset the
  provider reported (15 min if none, at most 8 days), the next account takes over
  and the step runs again on the same route, unseen. Only when none is left does
  the turn fall to another provider. A limit within 30 s of a switch may come from
  the previous account's cached login and is retried, not recorded.
- **Boxes** reach it through one optional port, `subscriptionAccounts`
  (`subscriptionAccount` op in the box protocol); the edge owns the choice.
- **Known limits.** Chats of one user share the account in use (pins apply when no
  other turn is running); Grok plans are not included; Y²'s `list_models` does
  not list accounts yet.
- **Terms.** The Settings panel says "Use accounts you own; follow each
  provider's terms." Anthropic's Consumer Terms and OpenAI's Terms of Use bar
  sharing credentials or making an account available to anyone else, and
  circumventing rate limits or protective measures; neither says anything about
  one person holding several accounts. Rotating a person's own paid plans is not
  addressed either way, so it is a judgement call for them; nothing here pools,
  shares or resells access, and the Codex egress path is unchanged.
- **Live check.** `scripts/test-session.ts seed-accounts` creates three synthetic
  Claude accounts (tokens valid nowhere) on the test account and
  `simulate-limit` runs the real rotation; the Settings list is then
  screenshot-able. Removing them in Settings (or seeding again) clears them;
  `reset` removes only these synthetic accounts.

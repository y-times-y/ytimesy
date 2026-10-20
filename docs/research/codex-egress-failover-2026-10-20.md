# Codex subscription egress failover

## Why

Plain Worker fetches to `chatgpt.com/backend-api` get 403 HTML (see `codex-cloudflare-egress-2026-10-08.md`). Since 2026-10-08 the edge sends subscription traffic through the Workers VPC network binding `CODEX_EGRESS` (Cloudflare Gateway egress). On 2026-10-20 at about 12:55 PDT that path also started returning 403 (`SubscriptionMetadataFailure 403`), while the same login still worked from a laptop. Because only one egress path was active, Codex subscription chats stopped.

Requirement: blocking a single egress path must never stop the Codex subscription from working.

## Design (`src/server/adapters/codex-subscription-transport.ts`, `src/domain/codex-egress.ts`)

**Ordered paths per request.** The paths are `vpc` (when the invocation installed `CODEX_EGRESS`), then `relay-1` … `relay-8` from env. If the invocation has no VPC binding, only the relays are used, and as before the backend keeps the OAuth tokens. With neither, requests use ordinary `fetch` (Node and tests). Relays use the existing signed relay protocol (`/api/internal/codex-transport`, `x-ytimesy-delivery-*` HMAC). Each relay has its own signing key.

**Failover within one call, before any byte reaches the model loop.** A request moves on to the next path only when the current path is blocked:

| Blocked (try next path) | Never fails over (returned to caller) |
| --- | --- |
| 403 HTML or empty, 401 HTML | JSON 401 (`token_expired`; the existing force-refresh retry runs first), empty 401 |
| any `cf-mitigated` header (challenge) | 429 rate limit / `usage_limit_reached` |
| Cloudflare `error code: 1010/1020/...` pages | JSON 4xx request errors, JSON 5xx provider errors |
| non-JSON 5xx (gateway/edge error pages), 3xx | caller cancellation |
| connection/transport errors | token-read errors, `CodexReconnectRequired`, account-changed fence |
| no response headers in time (6 s metadata, 45 s inference, 10 s relay identity) | |
| relay: `subscription_egress_blocked` / `subscription_transport_error`, or a non-JSON relay reply (bad signature, missing key, wrong service) | relay: `subscription_upstream_error`, `usage_limit_reached`, 409 account changed |

The relay now classifies its own upstream response with the same rules. It answers `subscription_egress_blocked` when its own IP is blocked, so a relay that is also blocked counts as a block and not as a provider rejection. Upstream bodies still never cross the relay.

- Inference bodies can be replayed: the AI SDK posts `JSON.stringify(body)` (`@ai-sdk/provider-utils` `postJsonToApi`), and relay inference already required a string. A body that is not a string uses only the first path.
- Failover ends once response headers arrive. A stream that fails partway is never retried.
- The last candidate gets no header deadline of its own because there is nowhere left to go. With a single candidate the caller sees exactly what it saw before (the same status or the same error). With several candidates that all fail, the call throws `CodexEgressUnavailable`, for example "Codex subscription is unreachable: every network path was blocked (vpc: forbidden-html, relay-1: timeout). Nothing was sent to the model…". Model failover treats that as an `outage`, so a configured API model can take over.

**Path health.** `CodexEgressHealth` keeps each blocked path out of use for 5 minutes. Healthy paths keep their configured order. Cooling paths follow as a last resort, soonest-expiring first, so a request is never refused while some path might still work. After the cooldown the path is tried again; a success clears it and logs `Codex egress path recovered.` Health is held **per isolate, in memory**. No shared store was added because the edge has no KV namespace, and a per-request Postgres read would add latency. The cost is at most one fast failed attempt per isolate per cooldown. A shared record would need a new binding (KV, or a small Durable Object), so it is left for later.

**Observability (no secrets, no URLs; path ids are `vpc`, `relay-N`, `direct`).**
- Step timing span `egress:<path>` (records which path served the request, in development debug traces).
- `console.warn` lines: `Codex egress path blocked.`, `Codex egress failed over.` `{served, blocked}`, `Every Codex egress path is blocked.`
- Owner email (kind `codex-egress`): once per path per hour when a path is newly blocked, and once per hour when every path fails.
- PostHog event `codex_egress_failover` `{path, reason, outcome: switched|exhausted}`.

**Health probe.** `probeCodexEgress(userId)` requests `codex/models` on every path in configured order, updates health and alerts. A reachable path that answers with an account error counts as healthy. The edge's existing per-minute `scheduled` handler runs it every 5 minutes when `YTIMESY_CODEX_EGRESS_PROBE_USER_ID` is set. No cron trigger was added. Because health is per isolate, the probe mainly serves alerting and early detection; live requests in other isolates learn from their own attempts.

## What to deploy and set

1. **Relay hosts (one or more, each with its own dedicated static egress IP, ideally in different providers or regions).** Each one runs this repo's Node server: the app's `/api/internal/codex-transport` route, or a minimal Node wrapper around `handleCodexSubscriptionRelay` like `scripts/verify-edge-subscription-relay.ts`. It needs:
   - the server configuration validated by `src/server/config.ts` (database URL and token-vault key) for the target environment, because it reads and refreshes the account's OAuth tokens itself;
   - `YTIMESY_CODEX_RELAY_SECRET`: that host's signing key (at least 32 characters, unique per relay);
   - public HTTPS at exactly `https://<host>/api/internal/codex-transport`, with no redirects. The signature covers the path, not the host.
2. **Edge executor and web Worker secrets** (`scripts/deploy-edge-development.ts` / `scripts/deploy-production.ts` forward them and refuse half-configured relays):
   - `YTIMESY_CODEX_RELAY_URL` + `YTIMESY_CODEX_RELAY_SECRET`: relay 1;
   - `YTIMESY_CODEX_RELAY_URL_2` + `YTIMESY_CODEX_RELAY_SECRET_2` … `_8`: further relays, tried in order;
   - `YTIMESY_CODEX_EGRESS_PROBE_USER_ID` (optional): the owner account whose Codex login the 5-minute probe uses.
   The `CODEX_EGRESS` VPC binding stays first; no wrangler config change is needed.
3. **Migration** `supabase/migrations/20261020130000_owner_alert_codex_egress.sql` adds the `codex-egress` owner-alert kind. Until it is applied, the alert claim insert fails and alerts fall back to per-isolate dedupe.
4. **Verify** after deploying: run the probe, or temporarily point relay 1 at a host that returns 403, and confirm a chat still answers through relay 2 and the alert email arrives.

## Per-user egress through the user's Freestyle VM (design notes only)

Each chat already has a Freestyle VM with its own outbound IP. That makes it a natural last-resort path, and its egress looks like an ordinary residential or cloud client for that user only.

- Shape: add a path kind `vm`, placed after the shared relays, that calls a small relay inside the guest (the existing pinned guest CLI could host it) over the authenticated channel the executor already uses for tool calls. The request envelope would be the same `operation` schema.
- Tokens: the guest must not hold long-lived OAuth refresh tokens. The edge would pass a short-lived access token per request, which is acceptable because the VM is the user's own machine, but it is still a credential inside untrusted code the agent can run. Prefer an in-guest relay process that the agent's shell cannot read: a separate user, with the token held in memory only.
- Costs and limits: requires the VM to be awake, which is usually true during a turn but never for catalog/usage reads from the web UI. Adds a round trip through the VM. Freestyle's IP pool can itself be blocked. Inference traffic counts against VM network use.
- Recommendation: build it only if shared static-IP relays are blocked repeatedly. It spreads risk across IPs but adds credential exposure and complexity.

## Tests

`src/domain/codex-egress.test.ts` (classification, cooldown ordering) and `src/server/adapters/codex-egress-failover.test.ts` cover these cases: same-request resend on a VPC block, relay order, cooldown skip and re-probe, no failover on 401 JSON, 429 or 400 JSON, no retry after the stream starts, a non-replayable body, a timeout before headers, a transport error, caller cancellation, the all-paths-failed message, relay blocked classification, and the probe.

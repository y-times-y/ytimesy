# Codex subscription with the ytimesy-owned model loop

Live operator proof, 2026-10-01. This is not a production routing change.

## What ran

`scripts/prove-codex-subscription-harness.ts` reused the existing
`connectedLanguageModel` OpenAI Responses adapter and the AI SDK `streamText`
multi-step loop used by our API harness. It loaded the sole connected owner's
encrypted device-code credential and selected their saved `gpt-6.1-sol` model.
It did not launch native Codex, refresh tokens, provision VMs, write chats, or
use API keys. Credentials and account identifiers were not logged.

The model called a read-only fixture tool implemented by this process. Only
the tool had a random verification code. The model returned that code after
receiving the result, then repeated it in a second conversational turn without
another tool execution. Both final responses had finish reason `stop`.

## Observed results

| Route | Result |
| --- | --- |
| Public `https://api.openai.com/v1/responses` | HTTP 401; no inference or tools |
| `https://chatgpt.com/backend-api/codex/responses` | Three HTTP 200 responses; both turns verified |

The Codex route produced 24 text deltas and one tool execution. First observed
tool/text activity arrived after 2,246 ms; both turns together took 7,595 ms.
No reasoning-summary deltas were emitted in this short low-effort test, despite
requesting summaries. This does not prove immediate reasoning display.

## Proof boundary

This establishes that the existing device-code credential can technically run
a ytimesy-owned AI SDK model/tool loop through the Codex backend, without the
native Codex inference process. It does **not** exercise `runApiAgent`'s durable
worker, VM tools, delegation, cancellation, compaction, replay, browser UI,
token refresh or multiple-user isolation. Those production integrations remain
unchanged and require separate verification before switching the product.

The documented Sign in with ChatGPT plan-sharing integration specifies the
public Responses API and explicitly says not to use ChatGPT backend endpoints
for that flow. Successful backend inference is not proof of partner approval
or a supported public integration contract. See the
[official models and inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

To repeat this bounded operator test with the existing development environment:

```sh
CODEX_SUBSCRIPTION_PROOF=1 node --env-file=.env --import tsx scripts/prove-codex-subscription-harness.ts
```

The script fails setup if there is not exactly one connected account or its
saved access token expires within three minutes. It allows at most four
requests per route, no retries, one fixture-tool execution per route, and a
60-second timeout per conversational turn. It must not be exposed as a public
endpoint or used for automatic production fallback.

## Usage wiring — 2026-10-01

Settings now queries account-scoped subscription windows directly through an
authenticated server function, independently of the native runner. The UI
refreshes only while the Agents settings section is open, with a 30-second
client stale time and a 60-second polling interval. Provider failures do not
expose transport payloads or erase an existing native usage snapshot.

`runCodexSubscriptionAgent` now uses the same `runModelAgent` streaming/tool
loop as API runs. Its adapter resolves context capacity from the authenticated
subscription catalog. Each completed step emits context based on that step's
input plus output tokens, separately from cumulative billing usage. Compaction
events preserve the previous count until fresh measured usage arrives. These
events attach to the current user turn and survive JSON persistence; the
composer can render them with the existing context ring and popover.

Live verification through that shared loop produced one fixture-tool call and
two successful conversational turns: 136 then 169 current-context tokens,
against the returned 272,000-token capacity. Serialized/reloaded items retained
the same context. Direct subscription metadata returned 30% used in the
7-day window. No execution VM or native inference runner was started.

Authenticated agent-browser verification opened Settings → Agents and observed
the existing native snapshot (13%) replaced by the fresh direct reading (30%),
with its reset timestamp and a new last-updated time. The existing chat's native
context ring remained visible; the direct-loop context was verified through
serialized events, not by switching that chat's runtime.

Repeat with `CODEX_SUBSCRIPTION_PROOF=1 node --env-file=.env --import tsx
scripts/prove-codex-subscription-usage.ts`. This proof creates no chats or VMs.

This wires the direct adapter's telemetry and the live Settings query, but does
not switch ordinary Codex chats or the durable job dispatcher away from the
native runtime. That routing change is separate; the direct adapter is not
represented as a fully deployed production runtime.

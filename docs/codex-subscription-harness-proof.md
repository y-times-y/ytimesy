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

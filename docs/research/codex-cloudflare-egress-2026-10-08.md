# Codex subscription requests from Cloudflare

## Evidence and limits

Our paired probe returned HTTP 200 from Node and HTTP 403 HTML from Cloudflare for the same account's catalog and inference requests. Our authenticated Node relay subsequently passed live inference, VM-tool execution, usage accounting and reconnect streaming. These tests did not isolate a particular upstream blocking rule.

The maintainer of [background-agents issue #1374](https://github.com/ColeMurray/background-agents/issues/1374) reports a single-variable experiment: adding `CF-Worker` to a working Node request changed HTTP 200 to HTTP 403 HTML. Their Worker header-removal attempts failed. This is a first-party reproduction report, not our own header-isolation test or an OpenAI statement.

[Cloudflare documents](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker) that ordinary Worker fetch subrequests receive this provenance header. Cloudflare also distinguishes the header from `cf.worker.upstream_zone`, which WAF rules can inspect before the header is added. The exact OpenAI rule remains unknown.

## Alternatives

- A trusted Node transport relay is live-verified in our implementation. It does not move the model loop out of the Durable Object.
- [PR #1393](https://github.com/ColeMurray/background-agents/pull/1393) proposes `EGRESS.fetch` through a Workers VPC Network binding (`network_id: "cf1:network"`), and its author reports successful deployed subscription classification. The PR is closed and unmerged; this is not verified in our account.
- [Cloudflare's Gateway egress announcement](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/) and [VPC Network documentation](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) confirm account-wide public Internet egress through Gateway. However, the network documentation also states an active Tunnel, Mesh node or WAN on-ramp must reach target services. The account's actual requirements must be verified before claiming infrastructure-free operation. The documentation does not guarantee Codex acceptance or describe the reported header-removal behavior.
- [Merged PR #1408](https://github.com/ColeMurray/background-agents/pull/1408) instead uses API-key Chat Completions for classification. It is not a subscription-preserving fix.

## Our subsequent live verification

VPC/Gateway egress passed in this account: catalog HTTP 200 (506 ms), completed tiny subscription inference HTTP 200 (1,190 ms). The probe explicitly required the binding and could not fall back to ordinary fetch. No customer-hosted tunnel or persistent compute was added. Both disposable Workers were deleted.

The development DO executor now uses invocation-local `CODEX_EGRESS` for subscription transport. The full live proof completed in 18,090 ms, including independently verified VM file-read evidence, final assistant answer, token usage and completed reconnect streaming. The model was the existing saved `gpt-6-luna`; this is not a speed benchmark. Cleanup removes the disposable VM/chats and disables the model gate. Device-code auth and application dispatch are unchanged. No permanent Node relay URL is required for this tested DO path. Real cancellation/restart and broader rollout remain separate verification gates.

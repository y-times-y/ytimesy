# Working opaque TLS transport proof: tunnelfetch

## Scope

A disposable deployed Cloudflare Worker reached ChatGPT through a dedicated Freestyle TCP CONNECT forwarder using `tunnelfetch` 1.13.1, commit `e140fba`. The package implemented TLS in the Worker with its bundled system trust policy, rather than relying on the native TLS hostname override that failed in the earlier probe.

No OAuth credentials, customer prompts, database keys, or authenticated model inference were used. This establishes transport compatibility, not a completed production repair or an independent security audit.

## Source review

- Source: https://github.com/latentharbor/tunnelfetch
- MIT license; no runtime package dependencies.
- Implements its own TLS 1.2/1.3 and X.509 verification in JavaScript. Its security policy explicitly states that it has not received an external audit. This is a substantial new cryptographic trust dependency, not a risk-free substitute for platform TLS.
- The inspected release was pinned by checkout commit for the proof; it was not added to application dependencies.

## Executable results

The disposable Worker used `Client({connect, proxy, trust: {mode: 'system'}})` and fetched the fixed endpoint `https://chatgpt.com/backend-api/codex/models` with no Authorization header, manual redirects, and a 20-second probe-only cancellation signal. The forwarder accepted only `CONNECT chatgpt.com:443`, forwarded opaque bytes, and had a five-minute process lifetime. It was deliberately credential-free and was not a production authenticated proxy.

Results from the deployed runtime:

1. System trust: `{"status":401,"type":"application/json"}`. This is the expected unauthenticated upstream response, not a failed network path.
2. Deliberately invalid SPKI pin: `CERT_PIN_MISMATCH`.
3. Custom verification invoking the package's `verifyChain` against `wrong-host.invalid` for the actual ChatGPT chain: `CERT_NAME_MISMATCH`. This exercises the hostname verifier with an incorrect identity; it is not a test against an independently provisioned malicious TLS server.

The IPv6 connect adapter had to restore square brackets around the literal hostname supplied to `cloudflare:sockets.connect`. Without this, TCP connection failed. Workers also rejected `redirect: 'error'`; the proof was corrected to `manual`.

Commands actually run:

- `git clone --depth 1 https://github.com/latentharbor/tunnelfetch.git .ytimesy/tunnelfetch-review`: exit 0.
- `npm test` in the isolated checkout before installing its dev dependency: exit 1, 1,292 passed / 4 failed out of 1,296; type-checking prerequisites were missing.
- `npm install --ignore-scripts --no-audit --no-fund` in that checkout: exit 0.
- `npm test` after installing dependencies: exit 1, 1,295 passed / 1 failed. Remaining failure: checked-in generated declaration drift, including Node timer types. Do not describe the full upstream suite as passing.
- `pnpm exec wrangler deploy --config .ytimesy/tunnelfetch-review/wrangler.jsonc`: exit 0 for each deployment.
- First `curl -fsS --max-time 35 https://ytimesy-tunnelfetch-proof.hetkp8044.workers.dev`: exit 22 / HTTP 404 immediately after first deployment. A subsequent call reached the Worker and exposed the invalid redirect option.
- Subsequent `curl -fsS --max-time 35 https://ytimesy-tunnelfetch-proof.hetkp8044.workers.dev`: exit 0; after IPv6 adapter correction returned JSON HTTP 401 evidence above.
- `curl -fsS --max-time 35 'https://ytimesy-tunnelfetch-proof.hetkp8044.workers.dev?badpin'`: exit 0; returned `CERT_PIN_MISMATCH`.
- `curl -fsS --max-time 35 'https://ytimesy-tunnelfetch-proof.hetkp8044.workers.dev?badhost'`: exit 0; returned `CERT_NAME_MISMATCH`.

## Cleanup

The public temporary firewall rule `fw-7d3454aa0c2a4862ac6669c66685159d` and disposable Worker `ytimesy-tunnelfetch-proof` were deleted. The forwarder was stopped, its uploaded Python script removed via the Freestyle file API, and VM `vm-5532c00fd90d4aeca2a3320ff628e019` paused. Cleanup batch exited 0. The isolated library checkout remains under gitignored `.ytimesy/` for further review; it contains no credentials.

## Required before production

- Decide whether the unaudited userland TLS implementation is an acceptable cryptographic dependency; do not call this a zero-tradeoff solution.
- Package a persistent authenticated, fixed-destination proxy with restricted networking, resource limits, restart supervision, and credential-safe operational logs. Never promote this temporary unauthenticated forwarder.
- Integrate behind the existing invocation-scoped transport adapter, preserving provider error semantics, token refresh, streamed bodies, cancellation, and no uncertain request replay.
- Verify streaming and cancellation with controlled fixtures, untrusted and expired certificate rejection, and authenticated subscription inference on the real deployed integration.
- Ensure future production deployments retain the proxy configuration and monitor the actual authenticated egress path.

Production remains unchanged. No public harness port is necessary for these research notes; any future model-transport implementation must separately assess that boundary.

# Codex opaque tunnel production rollout — 2026-11-07

## Deployed

- Dedicated Freestyle VM: `vm-5532c00fd90d4aeca2a3320ff628e019` (Test team).
- Restricted systemd service `ytimesy-codex-proxy`, active; automatic service restart and VM restart enabled. VM remains awake and incurs allocated-resource charges.
- Firewall ingress rule `fw-456ef27d53b14844b3a06381c8898bb8`, port 18080. Proxy only accepts fixed ChatGPT CONNECT requests with short-lived, single-use HMAC credentials. The VM's existing public outbound rule remains; narrower egress filtering is not yet configured.
- Production executor version: `2b1c5d2b-2164-4c3c-b827-963b8301ddd3`.
- Production web version: `2f841c0c-11b3-408d-9027-c4b4f8cc28ea`.
- Both deployed additively with `YTIMESY_CODEX_TUNNEL_URL` and `YTIMESY_CODEX_TUNNEL_SECRET`; existing secrets were retained. No database or vault credentials were copied to Freestyle.

## Commands and verification

- `pnpm exec wrangler deploy --config wrangler.edge-executor.jsonc --env production --secrets-file .ytimesy/codex-deploy/tunnel-secrets.json`: exit 0 after refreshed authorization. Earlier attempt failed with insufficient VPC permission (10196).
- `pnpm exec wrangler deploy --config dist/server/wrangler.json --secrets-file .ytimesy/codex-deploy/tunnel-secrets.json`: exit 0.
- `curl -fsS --max-time 15 https://edge.ytimesy.com/health`: exit 0, returned `{"build":"development"}`. This direct emergency rollout did not stamp a release build ID; this response proves availability, not source identity. Version IDs above identify the deployments.
- `curl -sS -o /dev/null -w 'web_status:%{http_code}\n' --max-time 20 https://ytimesy.com/`: exit 0, HTTP 200.
- Freestyle `systemctl is-active ytimesy-codex-proxy`: exit 0, active. Journal showed successful startup without request contents.
- Before rollout, a disposable Worker using the real application adapter with the signed proxy settings completed verified TLS and received ChatGPT's unauthenticated JSON 401; unsigned proxy requests were refused. Temporary proof and database-count Workers were deleted.
- Production running-turn preflight counted one running turn, confirmed to be this deployment chat, and no other running turns. Existing deferred DO update strategy retained.

## Limits

Authenticated GPT inference through the newly deployed production versions has not been independently verified. A working unauthenticated catalog route is not proof that token refresh, a complete model stream, or user-visible recovery succeeded. Ask for a real Codex chat retry and inspect its result before calling the incident resolved.

This uses pinned `tunnelfetch` 1.13.1, whose userland TLS implementation is not externally audited. Prior deployed checks rejected incorrect certificate pins and a deliberately incorrect expected hostname. Those checks are not a security audit. A single Freestyle egress remains a reliability dependency and its IP can still be rejected upstream.

The emergency deployment used Wrangler directly because production secret values were unavailable locally; normal deploy-script preflight was not run. Saved pre-deploy version IDs and tunnel settings remain in the gitignored `.ytimesy/codex-deploy/` operator directory, not in Git. The normal deployment script now forwards the two tunnel settings when supplied; operators must preserve them in the canonical production configuration.

No public harness port is required for this product-specific cloud infrastructure.

## Follow-up — 2026-11-10: the proxy accepted IPv6 only

Production logged `Every Codex egress path is blocked` (`path: vpc`, `reason: transport`) from 2026-11-09 23:37 UTC. On the proxy VM the service was active and listening, but only on `[::]:18080`: `asyncio.start_server(handle, "::", …)` makes that socket IPv6-only, so a connection to `127.0.0.1:18080` (or the VM's IPv4 address `169.254.77.2`) was refused. A signed request over `::1` worked end to end (200 from the proxy, ChatGPT's 401 behind it), so the key, the clock and the VM's path to `chatgpt.com` were fine.

Fix, applied on the VM only (not in this repo): `/opt/ytimesy-codex-proxy.py` line 78 now binds `["0.0.0.0", "::"]`; the original is at `/opt/ytimesy-codex-proxy.py.bak`. After the restart both `127.0.0.1` and `::1` returned 200 plus ChatGPT's 401.

Not verified: that the Worker was in fact connecting over IPv4 (so this is the likely cause, not a proven one), why it worked on 2026-11-07, and a real Codex request through the production Workers afterwards. The proxy logs nothing about refused requests (it only answers 403), so a wrong signing secret, an expired credential and an unreachable address all look the same from the Worker: `transport`.

If the VM is rebuilt, rebind the proxy to both `0.0.0.0` and `::`.

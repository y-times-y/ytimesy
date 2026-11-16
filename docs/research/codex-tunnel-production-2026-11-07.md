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

## 2026-11-10: the proxy moved from Freestyle to AWS

Reason: the Freestyle VM (2 vCPU, 4 GiB, always on) cost roughly $80-100 a month for a script that copies bytes. It was deleted on 2026-11-10 once Codex worked through AWS.

Now: one `t4g.nano` (Ubuntu 24.04 arm64, `i-085117377ce2e2e08`) in AWS account 703705584492, us-east-2, with Elastic IP `3.143.8.158` (`eipalloc-078d4c2decbd22814`) and security group `sg-04c90283931cbd7ce` (ingress tcp/443 from anywhere; auth is the signed single-use credential). Same proxy script, bound to `0.0.0.0` and `::`, as a systemd service `ytimesy-codex-proxy` (`PORT=443`, `CAP_NET_BIND_SERVICE`, signing key in `/etc/ytimesy-codex-proxy.key`, written by the instance's startup script). IMDSv2 is required. Port 443 because it passes the most firewalls, including the chat machines' own egress filter.

Production: `YTIMESY_CODEX_TUNNEL_URL=http://3.143.8.158:443` and a new `YTIMESY_CODEX_TUNNEL_SECRET` on both Workers (edge version `264701cb`, web `1b3bf477`). Verified: a bad credential gets 403, a signed one gets a tunnel to chatgpt.com and its 401 with no Cloudflare challenge, and a real Codex chat worked afterwards with zero `Codex egress path blocked` events in the Workers logs.

Known limits: a single instance with no failover (the transport supports one tunnel URL; `YTIMESY_CODEX_RELAY_URL*` relays are separate and need the app route). Rolling back to the pre-move Worker versions no longer works, because they point at the deleted Freestyle VM. If the instance is lost, launch a new one with the same startup script and re-point the two secrets. Monthly cost was not measured; the estimate was about $7-10.

## 2026-11-16: Ed25519 credentials, no signing secret on the proxy (not deployed)

Owner's rule: no production secret on any AWS box. Until now the proxy held the Workers' shared HMAC key (`/etc/ytimesy-codex-proxy.key`, equal to `YTIMESY_CODEX_TUNNEL_SECRET`), so anyone who read it on the instance could mint credentials. This mirrors the runner-box change ([Runner box signatures](../claude-code-placement.md#runner-box-signatures-ed25519-no-signing-key-on-a-box-2026-11-16-not-deployed)).

- **Credential** (proxy password of user `ytimesy`, one per CONNECT): `e1.<expires ms>.<32-hex nonce>.<Ed25519 signature, 128 hex>` over `e1.<expires>.<nonce>.chatgpt.com:443`. The legacy form `<expires>.<nonce>.<HMAC hex>` is unchanged. The `e1.` prefix tells the proxy which one it got. Expiry (60 s, at most 65 s ahead) and the single-use nonce apply to both forms and share one nonce store.
- **Workers** (`codexTunnelCredential` in `src/server/adapters/codex-tunnel.ts`): with `YTIMESY_CODEX_TUNNEL_SIGNING_KEY` (base64 PKCS8 DER) they send only the Ed25519 form, even if the old secret is still set. Without it they send the HMAC form. A set but malformed key fails the request instead of falling back to HMAC. `scripts/deploy-production.ts` forwards the key when it is in the bundle.
- **Proxy** (`scripts/codex-connect-proxy.py`): it accepts the Ed25519 form when `CODEX_PROXY_PUBLIC_KEY_FILE` (`/etc/ytimesy-codex-proxy.pub`, base64 SPKI DER, not secret) exists, and the HMAC form when `CODEX_PROXY_SECRET_FILE` exists. It logs `Codex proxy on port 443 verifies: …` at start. It uses `python3-cryptography`, which ships in the stock Ubuntu 24.04 cloud image: the arm64 release manifest lists 41.0.7-4ubuntu0.4, and the tests pass against 41.0.7. If the public key file exists but the package is missing, if the key is malformed, or if no key file exists at all, it logs why and exits 78. The unit has `RestartPreventExitStatus=78`, so it does not restart-loop. It now binds `0.0.0.0` and `::`, like the live copy.
- **Unit** (`scripts/codex-connect-proxy.service`): final state, with the public key only, `PORT=443` and `CAP_NET_BIND_SERVICE`. The two lines that load the old secret are kept there as a comment for an optional transition.
- **Keys:** `node --import tsx scripts/generate-codex-tunnel-keypair.ts --private-key-out <file>` prints the public key and writes the private key to a new owner-only file. Add the private key to the production bundle as `YTIMESY_CODEX_TUNNEL_SIGNING_KEY`, then delete the file.

### Updating the live proxy (no SSH, no SSM)

`i-085117377ce2e2e08` is reachable only on tcp/443. Change it with a root-volume swap through a temporary repair instance, as for the runner boxes ([How boxes are built and updated](../claude-code-placement.md)). Because the Workers send exactly one form per CONNECT, the Workers and the proxy must switch together. The recommended order does it in one stop window, with the Workers deploy happening while the proxy is stopped:

1. **Before the window, read-only.** Decode the user data (`DescribeInstanceAttribute --attribute userData`). It writes the HMAC key, so it contains the secret. Find out whether it runs only once per instance (the default for a user-data script) or on every boot (bootcmd, a per-boot script, or a unit it installs). If it runs on every boot, it would write the key back. Generate the keypair and put the private key in the bundle, but do not deploy yet. Check whether any `YTIMESY_CODEX_RELAY_URL*` relay is configured: if none is, Codex chats fail for the length of the window, so pick a quiet time.
2. **Stop the proxy.** Take a CreateSnapshot of its root volume, then StopInstances.
3. **Repair instance.** Launch a temporary arm64 Ubuntu instance in the same AZ (us-east-2). Detach the proxy's root volume, attach it to the helper, and mount it at `/mnt/p`. Then:
   - Inspect `etc/systemd/system/ytimesy-codex-proxy.service`, any `ytimesy-codex-proxy.service.d/` drop-ins, and `opt/ytimesy-codex-proxy.py`. Diff them against the repo: the script should differ only in the bind line and the new code. Keep any live-only setting the repo unit lacks.
   - Confirm `usr/lib/python3/dist-packages/cryptography/` exists. If it does not, stop here and put the volume back unchanged. The new script would exit 78.
   - Copy the repo script to `opt/ytimesy-codex-proxy.py` and the repo unit to `etc/systemd/system/ytimesy-codex-proxy.service`, both root:root 0644. Remove any drop-in that loads the old key.
   - Write the printed public key to `etc/ytimesy-codex-proxy.pub` (root:root 0644).
   - Delete `etc/ytimesy-codex-proxy.key`, cloud-init's copies (`var/lib/cloud/instances/*/user-data.txt*`, `var/lib/cloud/instances/*/scripts/*`), and any other copy. To find them, grep the volume for a unique fragment of the old secret, including `var/log/cloud-init-output.log` and `var/log/journal`.
   - Unmount and detach.
4. **User data.** While the instance is stopped, use ModifyInstanceAttribute to replace its user data with a version that has no secret (or empty it). Put the root volume back on the proxy under its original root device name.
5. **Deploy the Workers** with the signing key in the bundle, using the normal `deploy-production-from-secret.ts`. The proxy is still stopped, so neither side ever meets the other's old form.
6. **Start the proxy.** Terminate the helper. Verify:
   - With the private key file from step 1 (not yet deleted), a credential from `codexTunnelCredential` gets `200 Connection Established` and then ChatGPT's 401: `curl --proxytunnel -x http://ytimesy:<credential>@3.143.8.158:443 https://chatgpt.com/backend-api/codex/models`.
   - Reusing that credential, or an HMAC one, gets 403 (curl reports `000`).
   - A real Codex chat works, and the Workers logs show no `Codex egress path blocked`.
   - Then delete the private key file.
7. **Retire the old secret.** Remove `YTIMESY_CODEX_TUNNEL_SECRET` from the bundle and run `wrangler secret delete YTIMESY_CODEX_TUNNEL_SECRET` on both Workers: the web Worker (`dist/server/wrangler.json`) and `--config wrangler.edge-executor.jsonc --env production`. `deploy --secrets-file` only adds and updates, so removing it from the bundle alone does nothing. Treat the old value as leaked: it was on the box and in its user data.

**Rollback** after step 5: the Workers already sign Ed25519. Rolling back the proxy alone (from the snapshot) therefore needs the Workers back on HMAC as well: run `wrangler secret delete YTIMESY_CODEX_TUNNEL_SIGNING_KEY` on both Workers, remove it from the bundle, and redeploy.

**Two-window alternative**, if the Workers deploy cannot run while the proxy is down. In window 1, install the new script and unit with the two commented `LoadCredential`/`CODEX_PROXY_SECRET_FILE` lines enabled, plus the public key. The proxy then accepts both forms. Deploy the Workers and verify. In window 2, delete the key, the cache and the user data as above, and disable those two lines. The secret stays on the box between the windows.

**Rebuilding the instance:** its startup script must write only `/etc/ytimesy-codex-proxy.pub`, never a key. A public key in user data is fine. That script is not in this repo.

Checked: TS signs and the proxy's own `authorize` verifies, under python3 with cryptography 50.0.2 and 41.0.7. The tests also cover tampered signature, nonce, expiry and version, another key's signature, a wrong user, expiry, too-long expiry, replay, each form accepted only while its key is present, and exit 78 without a key. In a local run of the real proxy process with only the public key, a signed CONNECT over `127.0.0.1` and `::1` reached chatgpt.com (its 401), and a replayed or HMAC credential got 403. Not done: nothing is deployed, the live instance was not touched, and its exact unit, drop-ins and user data are unknown.

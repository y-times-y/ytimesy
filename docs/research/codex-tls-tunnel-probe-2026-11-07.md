# Codex opaque TLS tunnel: local compatibility probe

## Goal

Keep the harness in its Durable Object, but forward encrypted ChatGPT traffic through a dedicated Freestyle machine without exposing OAuth access tokens or prompt plaintext to that machine. This is a transport investigation, not a model benchmark.

## Observed result

On 2026-11-07, local workerd through the installed Wrangler 4.149.0, compatibility date `2026-10-08` and `nodejs_compat`, reported `secureConnect` with `authorized: true` when `node:tls.connect` wrapped an in-memory `node:stream.Duplex` that had no remote peer. The underlying duplex wrote **zero bytes**. No TLS handshake or certificate verification against ChatGPT could have occurred.

The minimal Worker fetch handler constructed:

```js
const chunks = [];
const transport = new Duplex({
  read() {},
  write(chunk, _encoding, done) {
    chunks.push(Buffer.from(chunk));
    done();
  },
});
const socket = connect({
  socket: transport,
  servername: "chatgpt.com",
  rejectUnauthorized: true,
});
```

It raced `secureConnect`, `error`, and a one-second test timeout, then destroyed both streams and returned the result and total recorded bytes. The observed response was:

```json
{"result":{"secureConnect":true,"authorized":true},"bytesWritten":0,"expected":"TLS cannot succeed without a remote server and a verified certificate"}
```

Commands:

- `pnpm exec wrangler dev --config .ytimesy/tls-tunnel-proof/wrangler.jsonc --port 8799 --local`: reached Ready; intentionally stopped with `ytimesy-job stop` (process exit 143).
- Initial `curl --retry 3 --retry-connrefused --retry-delay 1 --max-time 10 -fsS http://127.0.0.1:8799`: exit 7 before startup completed.
- `curl -fsS --max-time 10 http://127.0.0.1:8799`: exit 0, returned the JSON above.

The temporary probe directory was removed after the test. No authenticated provider call, public tunnel, production deployment, or model inference was performed.

## Interpretation and boundaries

Do not use `node:tls` over a custom Duplex/WebSocket transport as evidence of encrypted, certificate-verified transport in this runtime. A success event alone is insufficient. The runtime source corroborates the risk: `internal_tls_jsstream.ts` constructs a synthetic socket with `secureTransport: 'off'`; `internal_tls_wrap.ts` skips native TLS upgrade unless the underlying transport is `starttls`.

Primary sources inspected:

- https://github.com/cloudflare/workerd/blob/main/src/node/internal/internal_tls_jsstream.ts
- https://github.com/cloudflare/workerd/blob/main/src/node/internal/internal_tls_wrap.ts

These moving upstream sources are supporting context, not proof that every deployed runtime has identical code. The local executable observation is the evidence for the installed runtime.

This does **not** establish that native TCP CONNECT plus `cloudflare:sockets.startTls({ expectedServerHostname: 'chatgpt.com' })` is infeasible. That separate approach still needs a reachable authenticated TCP endpoint, verified certificate rejection tests, and a deployed Worker proof. Do not substitute a homemade TLS implementation or disable certificate verification.

## Follow-up: deployed native TCP probe

A disposable Worker, `ytimesy-native-tunnel-proof`, was deployed with compatibility date `2026-10-08` and `nodejs_compat`. It used `cloudflare:sockets.connect` to the dedicated Freestyle VM's public IPv6 address on port 18080, requested a fixed `CONNECT chatgpt.com:443` tunnel, released the plaintext reader/writer, and called `startTls({ expectedServerHostname })`. The VM ran a disposable standard-library Python TCP forwarder with a bounded lifetime; it accepted no destination other than ChatGPT. This unauthenticated fixed-destination probe was temporary, not a production proxy.

Results:

- Unbracketed IPv6 failed to connect. Bracketed IPv6 reached the TCP forwarder and received its CONNECT acknowledgement.
- Both `expectedServerHostname: 'chatgpt.com'` and `'wrong-host.invalid'` ended with EOF before an HTTP response. Neither is a successful certificate rejection test.
- The forwarder recorded a client TLS record prefix `16030105a70100` and a server fatal handshake-failure alert `15030100020228`. The first client chunk contained neither requested hostname. These observations are consistent with the hostname override not taking effect; they do not identify every TLS failure cause.
- A Python `ssl.create_default_context().wrap_socket(..., server_hostname='chatgpt.com')` client on Freestyle, using the same forwarder over loopback, completed TLS verification and received `HTTP/1.1 401 Unauthorized` from the unauthenticated catalog request. Thus the forwarder and its upstream route can carry working TLS.
- Current upstream `sockets.c++` explicitly includes an autogate that can reject `expectedServerHostname` as unsupported. This supports investigating platform support; it is not proof of which autogate the deployed service uses.

Commands and actual outcomes:

- `pnpm exec wrangler deploy --config .ytimesy/native-tunnel-proof/wrangler.jsonc`: exit 0 on each of three probe deployments.
- `curl -fsS --max-time 40 https://ytimesy-native-tunnel-proof.hetkp8044.workers.dev`: exit 0; returned connect failures initially, then the EOF results. Transport command success is not TLS success.
- `curl -fsS --max-time 30 https://ytimesy-native-tunnel-proof.hetkp8044.workers.dev`: exit 0 for follow-up EOF observations.
- `npx freestyle vm exec vm-5532c00fd90d4aeca2a3320ff628e019 -- bash -lc '<Python loopback TLS control>'`: exit 0; certificate-verified HTTP 401. An earlier IPv4-loopback control exited 1 because the listener was IPv6-only; a self-public-address curl also timed out (curl 28).
- First forwarder replacement failed to bind because the old process was still running. Stopping the process by listening port and restarting resolved that probe setup error.
- Cleanup removed firewall rule `fw-6cae7acd4bd84c2380b7de8fb11738b4`, stopped the forwarder, paused the VM, and deleted the disposable Worker. The CLI cleanup batch exited 0, but shell removal of the uploaded script was denied; `npx freestyle vm fs rm vm-5532c00fd90d4aeca2a3320ff628e019 /tmp/ytimesy-tunnel-probe.py` then removed it successfully (exit 0). Temporary local proof files were removed.

No OAuth token, database key, prompt, or authenticated inference was used. No production Worker was changed. End-to-end encrypted Worker-to-ChatGPT transport remains **unproven** on this runtime. Do not deploy this path, claim certificate verification passed, or work around it by disabling verification. Next steps are to establish supported hostname-aware TLS transport with Cloudflare, or explicitly choose a trusted access-token relay with its different security boundary.

## Deployment state

Production was not changed by this investigation. Earlier setup created a dedicated Freestyle relay VM, `vm-5532c00fd90d4aeca2a3320ff628e019`; it was paused and its temporary public ingress rule removed before this investigation. No secrets or tokens were sent to it by this probe.

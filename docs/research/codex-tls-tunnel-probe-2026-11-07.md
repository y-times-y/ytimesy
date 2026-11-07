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

## Deployment state

Production was not changed by this investigation. Earlier setup created a dedicated Freestyle relay VM, `vm-5532c00fd90d4aeca2a3320ff628e019`; it was paused and its temporary public ingress rule removed before this investigation. No secrets or tokens were sent to it by this probe.

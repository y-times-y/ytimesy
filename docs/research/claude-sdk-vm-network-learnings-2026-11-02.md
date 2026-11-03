# Claude Agent SDK, VM networking, picker race: learnings (2026-11-02)

What we checked, decided and measured on 2026-11-02 (PT), so the next agent
does not redo it. Code references are to `main` at `d8d86a46`.

## 1. Claude plans: how others connect them, and why we use the Agent SDK

| Product | How the user connects Claude | Runs where | Source |
|---|---|---|---|
| [competitor] | `claude setup-token`, paste in Settings → Models | [competitor] cloud, Claude Agent SDK | docs.[competitor].ai/models-and-pricing (Subscriptions) |
| [competitor] | `claude setup-token`, paste in Settings → Integrations → Personal; stored encrypted, "stays outside the thread sandbox" | [competitor] cloud (and desktop via local `claude`) | [competitor].sh/docs/agent/models ("Claude Code subscription routing") |
| Amp | Link in Settings → Model Routing (method not public) | Orbs (Amp cloud) and runners, Claude Agent SDK | ampcode.com/news/use-your-claude-plan, ampcode.com/docs/the-dial |
| ytimesy | `claude setup-token`, sealed; edge proxy swaps it in, the VM only gets a per-turn grant | Chat VM, Claude Agent SDK | `src/server/services/claude-code-runner.ts` |

- [competitor]'s cloud support is only on `/docs/agent/models`; `/docs/desktop`
  covers local runs only. Read that page before saying [competitor] is local-only.
- Anthropic's article "Use the Claude Agent SDK with your Claude plan"
  (support.claude.com, updates 2026-06-15 and 2026-10-07) treats the Agent SDK
  and `claude -p` the same: both draw from the plan when signed in with it.
  It says nothing about third parties hosting it or storing tokens.
- The user decided not to re-raise the "intermediating tokens" grey area:
  everyone in the table does the same thing.

### The Agent SDK is a wrapper around the Claude Code binary

Checked in the package itself (`@anthropic-ai/claude-agent-sdk`): it starts the
bundled Claude Code executable (`pathToClaudeCodeExecutable`, "Uses the
built-in executable if not specified") with
`--output-format stream-json --verbose --input-format stream-json`. Same
messages as `claude -p --output-format stream-json`, so our stream parser
(`src/domain/claude-code-stream.ts`) reads both unchanged.

- SDK `0.3.N` bundles Claude Code `2.1.N` (0.3.296 → 2.1.296, read from
  its `manifest.json`). Bump both together and re-verify against the edge
  proxy.
- The only wire difference: user agent becomes
  `claude-cli/2.1.296 (external, sdk-ts, agent-sdk/0.3.296)`. Same single
  `POST /v1/messages?beta=true`; no new endpoints (our proxy allows only
  `/v1/messages`, `count_tokens`, `/api/hello`).
- SDK defaults to check: `settingSources` omitted = all sources (CLI
  default, loads CLAUDE.md); `systemPrompt` must be the `claude_code` preset
  plus `append`; `bypassPermissions` needs `allowDangerouslySkipPermissions`;
  forward Claude Code's stderr with the `stderr` callback (failure
  classification reads it).
- The SDK cannot run in the Durable Object (needs Node and a child process),
  so it runs on the VM: `src/domain/claude-agent-runner.ts` is written per run
  and run with `/usr/local/bin/node`; options go in `options.json`.
- Install (`src/domain/guest-cli-pin.ts`): local npm install under
  `/opt/ytimesy-claude-agent-sdk/<ver>`, then `chmod -R a+rX` so the reader
  user can run it. Tools image `sh-021cee906ea246dc98897219e82cace0` has it.

### How it was tested (reuse this)

1. Mock Anthropic API (a Python SSE server answering `/v1/messages`, logging
   every path) on the Mac: SDK runner vs plain CLI, then `resume`.
2. `runClaudeCodeStep` for real on a tools-image VM against the mock on the
   VM, as builder and as reader.
3. One real turn on dev through the UI (dev edge deployed from main).

### Pitfall found

- A read-only helper failed with `EACCES` "native binary ... failed to
  launch". The binary was fine: Node reports a `cwd` the user cannot enter
  as EACCES on spawn. The product grants the reader the checkout by ACL
  (`subagent-reader.ts`); a test must do the same.

## 2. Freestyle networking: what we use and why

| Feature | Used | Why |
|---|---|---|
| Firewall | Yes | Default-deny. "Full" mode adds one rule: public internet only (no private ranges, no other VMs). Restricted modes remove it. Metadata addresses are blocked in-guest in every mode. |
| TLS inbound routes | Yes | Previews and the desktop (port 6080) on per-VM `style.dev` names (HMAC labels, `vm-edge-routes.ts`). |
| TLS outbound rules | Yes | Per-domain egress for the restricted modes (Settings → Internet access: Full / Common dependencies / Allowlist only, built 2026-10-21, `vm-network.ts`). |
| Forward-auth | Previews only | Desktop does not use it (see §3). |
| VPC | No | One VM per chat; VMs never talk to each other. |
| Tunnels (WireGuard) | No | For a developer laptop or server into private networks; users connect from a browser. |
| TLS secret injection | No | Our edge proxy scopes the token to a running turn, caps requests, reads 401/403/limit responses to fail over, and keeps the token off a third party. Injection does none of that. |

- Traffic Freestyle delivers to a published domain bypasses the firewall by
  design; every published route needs its own lock (forward-auth or the
  desktop password).
- `style.dev` names are permanent once published ("The name is yours from
  then on", freestyle.sh/docs/vms/domains); there is no release API. They are
  free. On 2026-11-02 the account held 215 names, 36 in use; that is not waste.
- Firewall and TLS rules are removed with their VM: 0 orphans found.

## 3. Desktop: relay vs forward-auth, measured

The desktop route has no forward-auth; websockify requires a password only
our server holds, and the browser reaches it through the web Worker relay
(`src/server/sockets/desktop-session.ts`).

Measured on a dev VM (echo server behind websockify on a real Freestyle
route, 60 round trips per connection, from the Mac, two runs each):

| Path | Round trip p50 | p90 | Connect |
|---|---|---|---|
| Direct (what forward-auth gives) | 19–20 ms | 25–27 ms | 96–168 ms |
| Through a Worker relay (ours) | 22–24 ms | 29 ms | 280–290 ms |

Decision: keep the relay. +2–5 ms per action is not perceptible; switching
would add sign-in links and `style.dev` cookies for nothing.

Measurement pitfalls:
- TigerVNC blacklists a source after a few rapid unfinished handshakes
  ("RFB 003.003" + reason "Too many security failures"). Do not time with
  repeated VNC handshakes; use an echo server behind websockify.
- A Worker relaying a fetched WebSocket must set
  `binaryType = "arraybuffer"` on both sockets, or binary frames arrive as
  Blob and are sent on as the text "[object Blob]" (prod does this in
  `worker-sockets.ts`).
- There is no deployed dev web Worker; the real relay exists only in prod.
  A throwaway Worker on workers.dev reproduces the path (delete it after).

## 4. Model picker: pick replaced by a default

Picking a model from another harness's section (Claude Code from a Codex
chat) switched the harness first; until the new catalog loaded, the
composer checked the pick against a stand-in list and replaced it (clicked
Sonnet, got Opus). Timing dependent: invisible once the catalog was cached,
which is why a refresh "fixed" it. Fix `d8d86a46`
(`session-launcher.tsx`, `catalogSettled`).

## 5. Operating pitfalls hit today

- Deploy only from a checkout verified at `origin/main` and clean. The
  shared checkout was on `launch-fixes` (159 commits behind); deploying from
  it ran old edge code in prod for ~4.5 min.
- `main` is checked out by another worktree (`/private/tmp/ytimesy-front`);
  use `git switch --detach origin/main` in the shared checkout.
- While a session sits in a worktree, the user's `!` commands that touch the
  shared checkout are refused; exit the worktree first.
- Local dev server: pass `YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED=1` (and
  `YTIMESY_XAI_SUBSCRIPTION_ENABLED=1`), or the Claude Code and Grok
  sections do not show. Deploy scripts set them; `.env` does not.
- Scripts in a fresh worktree need `supabase/.temp/project-ref`,
  `.secrets/supabase-ca.crt` and `.ytimesy/{secrets.key,realtime-development.json}`
  copied from the main checkout (all git-ignored), and `pnpm install`.
- Builds and the dev server regenerate `src/routeTree.gen.ts`; restore it
  before committing.
- Auto mode refuses prod deploys from the agent; preflight
  (`--preflight-only`) is allowed. Give the user the deploy command.

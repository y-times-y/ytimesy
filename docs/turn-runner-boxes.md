# Turn runner boxes

Decision (2026-11-15): API-connection turns (and later Codex's) run their
model loop on AWS "turn runner boxes", not inside the chat's Durable Object.
The chat object stays the coordinator and the live viewers' hub.

## Why

A Durable Object is billed for every second it is awake, and a turn is mostly
waiting on a model's stream or a tool call, during which the object cannot
sleep. Cloudflare is paid out of pocket and capped at the Workers Paid plan,
so its included usage (400k GB-s, 1M Durable Object requests, 10M Worker
requests, 30M CPU ms a month) must cover all users together. AWS runs on
credits. Claude Code turns already work this way: the `claude` process runs on
a runner box and the chat object sleeps between short steps.

## Shape

- `src/server/jobs/box-runner.ts` is the box's process. It claims queued turns
  through the edge's claim endpoint (executor `node`), runs each with
  `runApiTurn` as steps (the same code the Durable Object runs, given
  `boxTurnPorts`: stage 2a below), and registers through the edge every 10 s.
- A turn is routed to the boxes when it is queued (`chooseTurnExecutor`): the
  deployment runs turns in Durable Objects, the user is in
  `YTIMESY_BOX_TURN_USERS` (ids, or `*`), the turn is an API connection's (not
  a Codex or Claude subscription's), and a box with room registered in the last
  45 s. Otherwise the turn runs in its chat's object exactly as before, so a
  down fleet never strands a turn.
- The box keeps the turn's history in process, saves progress to Postgres after
  every model call and tool result (checkpoints; writes cost no egress), and a
  new box loads it from there.

## Crash handling

1. A box that stops (crash, network loss, stop for an upgrade) stops renewing
   the turn's lease (`heartbeat_at`).
2. After 45 s `requeueInterruptedBoxTurns` (run by every box every 15 s and by
   the lease sweep) puts the turn back in the queue with its saved progress,
   `run_attempts + 1`, up to 3 times. A turn asked to stop is not resumed.
3. Another box claims it under a new lease; the old lease's writes are refused,
   so a returning box cannot write over the new one.
4. The new box starts as a resumed step: tool calls the lost box left
   unanswered are closed with an "interrupted, check the workspace first" result
   and never run again; at most the one model reply in flight is requested again.
5. A step that throws on a live box is retried up to 3 times (resumed), then
   the turn is failed (`abandonApiTurn`).
6. The workspace itself lives on the Freestyle VM, not the box.

## Cloudflare budget (the constraint)

Today the room coordinates a turn over HTTP: a lease renewal every 10 s and a
progress relay per update, each a Worker request and a Durable Object request.
From a box that is ~360 requests an hour for renewals alone and thousands for
progress, against ~10,000 Durable Object requests per user per month. So the box
must not talk to the room over HTTP per event. **Before the boxes are enabled for
any user**, coordination and progress go over one hibernatable WebSocket per
turn (a WebSocket message bills at 1/20 of a request), with renewals every 30 s
or less often and progress coalesced. Until then `YTIMESY_BOX_TURN_USERS` stays
empty and nothing is routed to a box.

## No secrets on a box (decided 2026-11-15)

A turn runner box holds no production secret: no database URL, no model
API keys, no token vault key, no Freestyle or GitHub credentials. It is a
thin client of the edge, like Cloudflare's own container egress pattern:

- The box authenticates to the edge with its own short-lived identity
  (rotated, revocable, scoped to "run turns"), never with a shared secret
  that also unlocks anything else.
- Claiming a turn returns a grant scoped to that one turn and its lease:
  the edge, holding the secrets, does the model call (streams it back), the
  workspace tool calls (Freestyle), checkpoint writes and progress, each
  checked against the grant. A lost box exposes at most the turns it was
  running, until their leases end.
- `src/server/jobs/box-runner.ts` (stage 2a) no longer reads a database or a
  provider key: it claims, registers and runs through the edge, and refuses to
  start when its environment holds a secret (`box-secrets-guard.ts`). Since
  stage 2b it builds the turn's workspace machines itself per turn
  (`edgeWorkspaceMachines`: `boxWorkspaceMachines` over the edge's `vm/*` with
  that turn's grant; see "Whole turn on a box").

## Thin-client edge API (stage 1, 2026-11-17)

Everything is behind `YTIMESY_BOX_TURN_USERS` (default empty: every route
below answers 404). It also needs `TURN_BOX_EDGE_PRIVATE_KEY` (edge only) and
`TURN_BOX_EDGE_PUBLIC_KEY` (what a box is configured with), Ed25519, base64
(`generateTurnBoxKeyPair`); without them the routes answer 503.

**Credentials** (`src/domain/turn-box-grant.ts`, Ed25519 via WebCrypto, so it
runs on Workers, Node and anywhere else):

- Box identity `ytbi1.<b64url {b,e,n}>.<b64url sig>`: the box's only
  credential, 24 h, revocable (`turn_runner_box.revoked_at`, migration
  `20261117120000`, `revokeTurnRunnerBox`). A revoked box's claims, renewals,
  registration and model requests are refused; its turns are taken over when
  their lease lapses.
- Turn grant `ytbg1.<b64url {u,s,t,l,b,e,n}>.<b64url sig>`: user, session,
  turn, lease id, box id, expiry (10 min), nonce. Renewed in the heartbeat
  response once past half its life (one replacement per grant nonce).
  Signatures cover the prefix, so an identity never verifies as a grant.
- Replay: a claim carries `x-ytimesy-nonce` and `x-ytimesy-ts` (+-60 s) and is
  single use per isolate (`TurnBoxReplayGuard`, bounded, refuses when full).
  Isolates do not share memory, so the guard is best effort; the fence that
  always holds is the lease predicate on every write.

**Endpoints** (`src/server/edge/turn-box-routes.ts`; types shared with the box
in `src/domain/turn-box-protocol.ts`). Every grant endpoint first loads the
turn with `readRunningApiTurn(turnId, leaseId)` (`id=$1 and lease_id=$2 and
state='running'`) and requires its user and chat to equal the grant's; no row
is 409 `lease-lost`. Writes then use the existing writers, whose SQL repeats
`where id=$1 and lease_id=$2 and state='running' and not cancel_requested and
heartbeat fresh`, so a box whose lease moved between the two is still fenced.

| Path | Auth | Calls |
|---|---|---|
| `POST /box/v1/register` | identity | `registerTurnRunnerBox` (refuses a revoked box) |
| `POST /box/v1/claim` | identity + nonce | `claimApiTurn(..., "node")`, returns identity fields + grant; a user not in the flag is released |
| `POST /box/v1/renew` | grant | `renewApiTurn` (RENEW_TURN_LEASE_SQL); may return a new grant |
| `POST /box/v1/checkpoint` | grant | `checkpointApiTurn` |
| `POST /box/v1/progress` | grant | `publishApiTurnProgress` |
| `POST /box/v1/finalize` | grant | `finalizeApiTurn` (returns the effective state) |
| `POST /box/v1/history` | grant | the running row's messages/items, gzip, 8 MiB cap, `version` (= `updated_at`) so an unchanged history is answered `notModified` |
| `POST /box/v1/reserve` | grant | `reserveApiTokens` (429 on budget) |
| `POST /box/v1/cancel` | grant | `apiTurnCancelRequested` (`id, lease_id, user_id, cancel_requested`) |
| `POST /box/v1/model/<path>` | grant | model proxy, below |
| `GET /box/v1/socket` (upgrade) | grant | forwarded to the chat's Durable Object |

**Model proxy** (`src/domain/turn-box-model-proxy.ts`): API-key connections
only. The edge reads the turn's own `connection_id` (never the box's),
decrypts it, and streams to the provider's official origin (OpenAI, Anthropic,
Google, OpenRouter; `compatible`/custom hosts, subscriptions (xAI, Codex,
Claude) and any other origin are refused before any upstream call). Bodies are
streamed both ways, never buffered; redirects are refused; only an allowlist of
headers and a plain path (no `..`, no `//`, only an `alt` query) pass. It also
reserves the request's tokens from its Content-Length (bytes/3 + 24k, as the
loop does), so a step needs no separate reserve request (411 without a
Content-Length).

**Socket** (`src/server/edge/turn-box-socket.ts`): one hibernatable
(`ctx.acceptWebSocket`) socket per turn to the chat's Durable Object. Box to
DO: `progress` (coalesced, at most one message per 500 ms, latest items win;
`LatestCoalescer`) and `renew`, both acked and lease-checked like the HTTP
endpoints; DO to box: `cancel` (pushed when the Stop request reaches the
object), `lease-lost`, `ack`. The box falls back to HTTP `progress`/`renew`
when no socket opens.

**Box client** (`src/server/jobs/turn-box-client.ts`): `TurnBoxEdgeClient`
(register, claim) and `TurnBoxTurnSession` (renew, checkpoint, progress,
finalize, history with version cache, reserve, cancel-check, socket,
`modelEndpoint()` for the SDK's base URL and key). `session.adapters()` has
the shapes of `renewApiTurn`, `checkpointApiTurn`, `publishApiTurnProgress`,
`finalizeApiTurn`, `apiTurnCancelRequested` and `reserveApiTokens`.

### Request-count estimate (a 40-step turn that streams ~5 s per step)

Measured in `turn-box-client.test.ts` against the real routes (fake database):

- Worker requests per step: 1 model request + 2 checkpoints (after the model,
  after the tools) = 3; per turn about **120 plus** claim, history, finalize
  and one renew/grant refresh. This is **over the ~100 target**. The reserve
  request was removed by taking it in the proxy (it was 160). Getting under 100
  needs fewer checkpoints (e.g. only the tool-result checkpoint when tools ran,
  or one per two steps), which weakens crash recovery and was not done.
- Durable Object requests: 1 socket upgrade + ceil(messages / 20). ~330
  progress messages (500 ms coalescing over ~165 s of streaming) + renewals
  (every 15 s) is **~19** per turn, over the ~10 target. Coalescing to 1 s
  would give ~10; a step with no live viewer needs no progress at all (the DO
  does not know viewers to tell the box yet).
- Not counted per user in the meter yet: see docs/cloudflare-budget.md.

### What the box still cannot do (not done)

- (Done in stage 2a, see "Turn ports": `box-runner.ts` claims through the edge,
  `runApiTurn` takes `TurnPorts`, no database URL or provider key is needed.
  What remains of this item is the table's "missing" rows and the services that
  still reach a database by name.)
- (Done in stage 2b: workspace tool calls go through `boxWorkspaceMachines`,
  plugged into `box-runner.ts`; see "Whole turn on a box".)
- Failover to another connection mid-turn: the proxy serves the turn's primary
  connection only.
- `inbox` in the renew response is always false (renewApiTurn does not return
  it); the inbox read now has an endpoint (`peerInboxRead`) and the box reads
  it every step instead.
- The history endpoint returns the stored row (messages/items, as written by
  checkpoints), not the merged page loader of the chat's Durable Object.
- A socket stays open for the turn; its grant is not re-verified per message
  (the lease and the box's revocation are, on each message).
- Nothing here ever ran against a real Durable Object, Postgres, Worker or AWS
  box: see the test list in the change report.

## Workspace tools from a box: `vm/*` (2026-11-17)

Still behind `YTIMESY_BOX_TURN_USERS`; no Freestyle account key reaches a box.
Files: `src/domain/turn-box-vm-protocol.ts` (paths, strict schemas),
`src/server/edge/turn-box-vm-routes.ts` (edge), `src/server/adapters/turn-box-vm-edge.ts`
(database/Freestyle composition for the Worker), `src/server/jobs/turn-box-vm-machines.ts`
(`boxWorkspaceMachines`, `turnBoxVmEdgeClient`), `turn-box-vm-guest.ts` (the scoped Freestyle client).
Shared-file hooks, all additive: `TurnBoxEdgeDeps.vm` plus one branch in `routeTurnBoxEdge`,
a release call after `finalize` and after a `cancel` that reports Stop, `vm:` in
`turn-box-worker.ts`, and the identity sweep also running when the box flag is set.

**Endpoints** (grant-authenticated; every one checks the user is enabled, loads the turn under
exactly the grant's lease/user/chat (409 `lease-lost`), the box is not revoked, and Stop was not requested (409 `cancelled`, identity deleted)):

| Path | Does |
|---|---|
| `POST /box/v1/vm/ensure` | secrets check, admission (usage windows, compute budget), start/resume/replace the chat's VM (existing workspace preparation incl. checkout), mint the turn's scoped identity. Returns `{vm, grant: {token, linuxUser, redactOnVm} \| null}`; `null` = the box's token is still valid for `knownVm`. |
| `POST /box/v1/vm/pause` | one thinking-pause check at the edge (`attemptThinkingPause`: other turns, background commands, viewers, terminals; the box reports `toolsRunning`) |
| `POST /box/v1/vm/op` | allowlist on the chat's own VM only: `keepAwakeForBackground`, `settleIdleTimeout`, `applyNetworkPolicy`, `snapshotEnvironment`. Anything else is 400. |
| `POST /box/v1/vm/release` | delete the turn's identity now |

**Token scope and lifecycle.** The phase 2a identity (`grantClaudeBoxTools`): a Freestyle identity that may only
run commands on that one VM as its default Linux user. Its id is stored on `api_turn.box_tool_identity` before it
gets any permission; the token is returned once and exists only in the box's process memory. Minted by the first
`ensure` (once per turn: later `ensure` calls with the same `knownVm` return `grant: null`); replaced on `remint`
or a replaced VM (the old one is deleted first). Deleted at turn end (`finalize`), on Stop (the next `vm/*` or
`cancel` request, and via `finalize`), by `vm/release`, and by the cron sweep (`sweepClaudeBoxToolIdentities`: turns
no longer running or without a heartbeat for 3 min). Lease loss: the old lease cannot revoke its successor's identity
(the record is lease-filtered), so a lost lease's identity is deleted by the sweep (up to a few minutes, as for Claude) or by
the next mint (which deletes the turn's current one first).

**What needs the account key, and how.** Start/resume/replace the VM, admission, minting/revoking identities,
pausing, keep-awake and idle timeout, network policy and environment snapshots: all through `vm/*` (the key is read
at the edge, inside `createFreestyleWorkspaceMachines`, and every response body is parsed through a strict schema).
Not available on a box (throw): `destroy`, `provisionSession`, `createProofWorkspace`, `exposeHttp`, `destroyOrphans`,
`destroySnapshot`, forks, runCapability, `readFile` (bytes). Checkout setup is done by `ensure`'s preparation.

**Secrets.** Raw project secret values never go to the box. With runtime secrets the project stays off the box
(`403 secrets`) unless `YTIMESY_CLAUDE_BOX_TOOLS_SECRETS=1`; then the VM must redact itself (`redactOnVm`, probe
before the grant, as phase 2a) and the box's output passes `vmRedactedCommand`/`unwrapVmRedaction`. A turn refused
this way has nothing to run on the box: since stage 2b `chooseTurnExecutor`'s caller keeps such turns in the Durable Object at routing time (`boxTurnBlock`).

**Pause while thinking** (`YTIMESY_PAUSE_VM_WHILE_THINKING`). The scoped identity cannot resume a VM (exec only; a
paused VM answers 4xx and nothing ran). So the box (a) asks `vm/pause` after its quiet grace, remembers it paused, and
(b) before its next guest call asks `vm/ensure` (cheap, idempotent, resumes via the account key), and (c) on a
refused-before-running guest call, asks `vm/ensure` once and retries. Resuming through the identity is not allowed.
The box does not use `resumingAfterThinkingPause` (its records are per isolate).

**Worker requests.** Per turn: 1 `vm/ensure` (+1 `vm/release`, or free at `finalize`). Per tool call: **0**
(exec/read/write go straight to the VM with the scoped token; one command each, a write over 768 KiB is more commands, never more Worker requests).
Per pause cycle: 2 (`pause` + `ensure`). Per detached command: up to 2 (`keepAwakeForBackground`, `settleIdleTimeout`).
Per network-policy or snapshot call: 1. Not batched further because nothing else needs the edge in steady state.

**Never run against** real Freestyle, Postgres, a Worker or an AWS box: `turn-box-vm-edge.ts`, `turn-box-vm-guest.ts`
and `turnBoxVmEdgeClient` over HTTP are untested beyond fakes. Also not done: `vm/ensure`'s preparation running without the DO's per-turn memo/reuse (it may repeat checkout work each call). (Done in stage 2b: `runApiTurn` over `boxWorkspaceMachines`, and routing projects with runtime secrets away from boxes.)

## Turn ports (stage 2a, 2026-11-17)

Still behind `YTIMESY_BOX_TURN_USERS` (default empty: the `port` endpoint, like
every other box route, answers 404).

`runApiTurn(machines, turn, step, ports = localTurnPorts)` no longer imports its
persistence/IO functions; it takes them as a `TurnPorts` object
(`src/server/jobs/turn-ports.ts`, types only, so a box can load it without a
database adapter). Each member has the type of the function it replaced, so the
call sites did not change (they destructure `ports` at the top of the step).

- `localTurnPorts` (`turn-ports-local.ts`): the same modules, each looked up
  when called (so a test's module mock still applies). The Durable Object path
  is unchanged: `api-turn*.test.ts` gives the same 240 results as before, and
  the same 18 failures in `api-turn.test.ts` that were there before (they are
  timing tests; one run under load showed 19, the same file).
- `boxTurnPorts(session)` (`turn-box-ports.ts`): over `TurnBoxTurnSession`
  (`session.port(op, args)` = `POST /box/v1/port {op, args}` plus the stage-1
  adapters). Its imports reach no `server/adapters`, `server/services`, database
  or provider SDK (`turn-box-ports-imports.test.ts` walks the value imports).
  It has `flush()` (batched analytics) and `modelAccess`.
- A box refuses calls naming another user, chat or turn before sending them, and
  the edge takes user, chat and turn from the grant's turn row, never from
  arguments (a project id or the parent chat must match the chat's own:
  `TurnBoxPortForbidden`, 403).

**The `port` endpoint** (`turn-box-protocol.ts` `boxPortArgs`, handlers in
`adapters/turn-box-port-handlers.ts`, routed by `routeTurnBoxEdge`). It is
checked like every grant endpoint: grant valid, box not revoked, `loadOwned`
(`id`, `lease_id`, `state='running'`, user, chat; else 409 `lease-lost`), args
validated (400), an op with no handler 501 `not-served`. Handlers only compose
existing functions: no new write SQL (the inbox select and accept moved out of
`injectServerPeerMessages` into `readPeerInbox`/`acceptPeerInbox`, same SQL).
Port writes do not repeat the lease predicate in SQL (the turn-row writers of
stage 1 do): the lease check happens once per request, before the write.

**Model SDK.** `ports.modelAccess` is passed to `runApiAgent(Step)` as
`modelAccess`: the connection is read from the edge WITHOUT `sealedCredential`,
the SDK's base URL is the edge proxy (`<edge>/box/v1/model`), its "API key" is a
placeholder, and its `fetch` is `grantRotatingFetch`: it puts the turn's
CURRENT grant (renewals replace it) in `authorization`, `x-api-key` and
`x-goog-api-key`, refuses any URL outside the proxy path (so the grant never
reaches another host) and refuses redirects. The provider's real `baseUrl` still
decides provider-specific behaviour; only transport uses the proxy
(`transportBaseUrl`). Subscription connections throw on a box.

### Every dependency of `runApiTurn`, and how a box gets it

Class (a): a stage-1 endpoint; (b): a `port` op added here; (c): edge-only or
post-step, not served; the Durable Object keeps doing it.

| Dependency (port) | Box gets it via | Status |
|---|---|---|
| `renewApiTurn`, `checkpointApiTurn`, `publishApiTurnProgress`, `finalizeApiTurn`, `apiTurnCancelRequested` | stage 1: socket/`renew`, `checkpoint`, `progress`, `finalize`, `cancel` | (a) done |
| `reserveApiTokens` | the model proxy reserves each request | (a) done (no-op on the box) |
| model call, provider key, `connectionApiKey` | model proxy + `modelAccess` + `grantRotatingFetch` | (a) done; API-key connections only |
| `loadModelConnection` | op `modelConnection`, credential removed | (b) done |
| `agentSessionMetadataForOwner` | op `sessionMetadata` (own chat or its parent) | (b) done |
| `subagentAncestors` | op `sessionAncestors` | (b) done |
| `projectImportedSessions`, `projectYMode` | ops `importedSessions`, `projectYMode` (project must be the chat's) | (b) done |
| `completedLifecycleContinuations`, `conversationPointCodeRef`, `readVerificationBaseline` | ops `lifecycleContinuations`, `conversationPointCodeRef`, `verificationBaseline` | (b) done |
| `readPreparedCheckoutDirectory`, `savePreparedCheckoutDirectory`, `readProjectDerivedValue`, `readSessionDerivedValue`, `saveSessionDerivedValue` | ops of the same names | (b) done |
| `enabledPluginSkillIndex`, `pluginSkillBody` | ops `pluginSkillIndex`, `pluginSkillBody` | (b) done |
| `harnessVariantForUser`, `isDevEvalUser` (settings reads) | ops `harnessVariant`, `isDevEvalUser` | (b) done |
| `otherRunningTurnOnMachine` | op of the same name | (b) done |
| peer inbox (`injectServerPeerMessages`) | ops `peerInboxRead`, then the box checkpoints, then `peerInboxAccept`; the decision is `planPeerInjection` (domain, pure), shared with the Durable Object | (b) done |
| `saveAgentTaskResultAndEvent`, `releaseHeldAgentTaskEvents`, `enqueueAgentTaskEvent` (agent-task events, background-job start) | ops `saveTaskResult`, `releaseHeldTaskEvents`, `enqueueTaskEvent` (the edge starts the job) | (b) done |
| `captureServerAnalytics` (usage/analytics) | op `analytics`, batched (up to 20 per request, flushed at turn end) | (b) done |
| `noteUserHub` | op `userHubNote` | (b) done |
| `noteCrewWaiting` (the turn ended on a card for the person; Y² crew) | op `crewWaiting`, fire and forget | (b) done |
| `archiveModelContext` (compaction storage) | op `archiveContext` (the edge encrypts and uploads) | (b) done |
| `recordCloudProjectReport` | op `cloudProjectReport` | (b) done |
| `coordinateConversationTurn` (chat lease with the room) | op `coordinateTurn` | (b) done; the box socket already ties the turn to the room, so this may be redundant: not settled |
| `loadAgentProjectSecrets` | op `projectSecretNames`: NAMES and kinds only; the box gets an empty env file and an empty redaction list | (b) done; values never leave the edge |
| `writeAgentProjectSecrets` (env file onto the VM) | op `writeSecretsToVm`: the edge loads the secrets and writes the env file with its own machines; no value reaches the box | (b) done (stage 2b) |
| `saveAccountWideSecret`, `saveVisibleProjectSecret` | not served (a secret value would pass through the box) | (c) missing: throws |
| `commitSessionTurn`, GitHub App publish, PR handoff (`replaceSettledTurnItem`) | op `commitTurn` (the edge commits before finalize, with its machines); the push and pull request run at the edge's `finalize` (`publish: true`) | (b) done (stage 2b); note: the Durable Object has no separate step-end for this, it all runs inside `runApiTurn` |
| `startQueuedUserTurn` (start the queued follow-up) | the edge's `finalize` starts it after the turn settled | (b) done (stage 2b); the box's port is a no-op |
| `ensureConversationCodePoint` | op `ensureCodePoint` (the edge captures on the chat's own VM) | (b) done (stage 2b) |
| `deferredApiTurnWorkspace`, `turnMemory`, `subagentMemory`, `withPushResultNotices` | new ports: the workspace is `vm/ensure`'s (`boxApiTurnWorkspace`); memory is off on a box; push-card notices are not delivered by a box | (b)/(c) stage 2b |
| `connectableMcpServers`, `turnOAuthProvider` | MCP servers carry headers and sealed OAuth | (c) missing: a box runs with no MCP servers (silently; no notice yet) |
| `gitPushRequests` (push approval) | | missing: methods throw when the tool is used; `withPushResultNotices` is a port now (no-op on a box) |
| `evaluationRunForTask`, `assertEvaluationActive`, `recordEvaluationUsage`, `reserveEvaluationRequest` | | (c) evaluation turns stay in Durable Objects: throw on a box |
| `pinnedClaudeRunner`, `claudeSubscriptionStatus`, `warmCodexSubscriptionCatalog`, `hasManagedCodexAuth`, `turnBoxToolIdentity` and its two writers | | (c) subscription routes never run on a box: throw |
| tools (Freestyle) | `boxWorkspaceMachines` over `vm/*`, built per turn by `box-runner.ts` | (a) done (stage 2b) |

**Not a port, still reached by name inside the loop.** Superseded by "Whole
turn on a box" below: the exact list is now `turn-box-bundle-imports.test.ts`
(49 modules, down from 54), and a real `runApiTurn` plain turn reaches none
of them with the database mocked to throw.

### The box's startup and environment

`runTurnRunnerBox` first calls `assertTurnBoxHoldsNoSecrets(env)`: it refuses to
run when `DATABASE_URL` or another database variable, a provider key
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_*`, `OPENROUTER_API_KEY`, `XAI_`
and anything ending `_API_KEY`), a vault or signing secret (`TOKEN_VAULT_KEY`,
`*_SECRET`, `*_PRIVATE_KEY`, `GITHUB_APP_*`), a Freestyle, storage, analytics or
AWS credential is set and non-empty. The error lists names, never values. What a
box needs: `YTIMESY_EDGE_URL`, `YTIMESY_BOX_IDENTITY` (its identity token),
`YTIMESY_MODEL_EXECUTION_TARGET=durable-object`, and the machines adapter.
`requeueInterruptedBoxTurns` no longer runs on the box (the edge's lease sweep
does); a box that stops just stops registering, and removal waits for the 45 s
window (`removeTurnRunnerBox` has no endpoint).

## Whole turn on a box (stage 2b, 2026-11-17)

Still behind `YTIMESY_BOX_TURN_USERS` (default empty). Nothing here ran
against a real Durable Object, Postgres, Worker, Freestyle or AWS box: every
test uses the fake edge (the real routes over an in-memory turn table), a fake
model upstream and a fake Freestyle guest.

**Routing** (`boxTurnBlock` in `src/domain/turn-executor.ts`, read by
`enqueueApiTurn` before the chat is locked; one read only for users the flag
enables, so the flag-off path is unchanged). A turn stays in its Durable
Object when: it is a subscription (Codex/Claude) route (as before); the chat
is a helper (`parent_session_id` set: reader, writer, checker, Y-squared
worker); it belongs to a harness evaluation run; the project or the user's
account holds a `runtime` secret and `YTIMESY_CLAUDE_BOX_TOOLS_SECRETS` is not
`1` (`vm/ensure` answers 403 `secrets` for those); or the routing read fails.
`environment`/`build` secrets do not block: the edge writes the env file
(`writeSecretsToVm`). Decided per turn at queue time; a chat can alternate
between executors. With the secrets flag at 1 a runtime-secret project runs
on a box with the VM redacting its own output (as for Claude boxes); that
combination is the least exercised.

**Workspace machines.** `runTurnRunnerBox` no longer needs `machines`: per
claimed turn it builds `edgeWorkspaceMachines` (`boxWorkspaceMachines` over
`turnBoxVmEdgeClient`, bearer = that turn's CURRENT grant, guest = the
scoped Freestyle identity). One `vm/ensure` per turn on first use; none per
tool call; `finalize` or a reported Stop delete the identity at the edge; a
turn that ends any other way (error, lost lease) calls `vm/release`.
`machines`/`machinesFor` are test hooks.

**What the loop gets instead of the database** (new `TurnPorts` members):
`deferredApiTurnWorkspace` (`boxApiTurnWorkspace`: `ensureRunning`, then
reads the repository path note the edge's preparation left; no replaced-VM
note and no pinned base for an early first request), `turnMemory` and
`subagentMemory` (null: **memory is off on a box**), `withPushResultNotices`
(null: a push card answered meanwhile gets no notice from a box). New ops:
`writeSecretsToVm`, `commitTurn`, `ensureCodePoint` (all act on the chat's own
VM from the chat's row, with the edge's account machines handed to
`turnBoxPort`). `runApiTurn` loads `localTurnPorts` with a dynamic import only
when no ports are passed, so a box never loads it.

**Commit, push and pull request.** In this code the Durable Object has no
separate step-end for them: `commitSessionTurn`, the push and the PR handoff
run inside `runApiTurn` on whichever executor runs it. So the hand-back is the
edge's: `commitTurn` commits before finalize (the work is kept; the notice is
shown); the box's finalize carries `publish: true` and the edge, after
`finalizeApiTurn` (and for a Stop that raced completion, as in the loop),
commits again (an empty commit is skipped), pushes, opens the draft PR and
replaces the PR item (`finishPullRequestHandoff`, now exported from
`api-turn.ts`). After a completed turn the same hook records the cloud project
report, releases held helper reports and starts the chat's next queued
message (`adapters/turn-box-edge-work.ts`, response-after where the platform
allows, every step best effort as at the end of `runApiTurn`). On the box
those ports are no-ops (the turn is no longer running, so a port call could
not be lease-checked).

**Still unavailable on a box (throw, or not delivered):** saving a secret from
the secret-request tool (`saveAccountWideSecret`, `saveVisibleProjectSecret`:
the value would pass through the box), push approval cards
(`gitPushRequests`), MCP servers (a box runs with none, silently), harness
evaluation, subscription routes, cross-chat memory, helper chats, failover to
another connection mid-turn. The edge's `finalize` post-work is not retried.

**Database imports in the box bundle** (`turn-box-bundle-imports.test.ts`,
entry `box-runner.ts`, static value imports): 49 modules outside
`server/adapters` import a database adapter directly (was 54); the test
fails when one is added or when an entry no longer applies. 23 are labelled
`routed-off` (their features are kept off boxes by routing or throw), 26
`debt` (loaded, not converted). The empirical check is `box-turn-e2e.test.ts`:
the real `runApiTurn` through `runTurnRunnerBox` with the database module
mocked to throw: an answer-only turn and a turn with a tool call and a commit
reach the database 0 times, and a watched environment shows no
`DATABASE_URL`, provider key or Freestyle key read. Paths those two turns do
not take (failover, attachments, compaction, MCP, background commands,
subagent tools, push approval) may still reach one.

**Stop and lease loss.** A Stop requested while the model streams ends the
turn as `cancelled` through the box (no commit, no publish). A lease taken
over mid-step: the stale box's writes are refused, the new owner's row is
untouched, no retry pauses. This test found two defects, fixed here: the fake
edge's `finalize` refused a turn asked to stop (the real SQL accepts it), and
a step's failure re-read of the turn must ask the edge, not use the box's
local copy.

### Request count (a 40-step tool turn, no live viewer), measured

`box-turn-e2e.test.ts`, Worker requests from the box to the edge, fast steps:

| | before (cuts off) | after |
|---|---|---|
| total | 431 (about 10.5 a step) | **102** (about 2.1 a step) |
| per step | model 1, checkpoint 1, history 1, renew 1, modelConnection 2, sessionMetadata 1, projectYMode 1, coordinateTurn 1, peerInboxRead 1 | model 1, checkpoint 1 |
| per turn (fixed) | register, claim, history, secrets names, imported sessions, plugins, workspace secrets write, code point (2), baseline (1-2), checkout directory (3), analytics (3), commit, release, finalize | same, each once; checkout directory 0-1 |

The cuts: reads fixed for a turn are asked once per turn on the box
(session metadata, model connection, project Y mode, imported sessions,
secret names, plugin index, derived values, baseline, checkout directory);
the same checkout directory is saved once; the coordination lease is
acquired once; the edge's `checkpoint` also renews the lease (one more
statement at the edge, no Worker request: `renewApiTurn` is the same SQL,
which `checkpointApiTurn`'s own SQL does not do: it only requires a fresh
heartbeat) and tells the box, which then skips a renewal within 5 s; steps
reuse the history the box last checkpointed instead of reading it; an empty
peer inbox is asked again after 10 s, not every step (a message sent to a
running turn can arrive up to 10 s later than in the Durable Object).
The target of ~100 for 40 steps is met in this run, with a floor of one model
request and one checkpoint per step. Not in this number: time-based costs
(with no socket, a lease renewal and a room-lease renewal about every 10 s
and progress writes; with the socket, renewals and progress are socket
messages, 1/20 of a request), and checkpoints a real tool-heavy step would
add (the fake tool returns at once).

## Not yet done

- Everything under "What the box still cannot do" above and "Still
  unavailable on a box" in stage 2b. Required before enabling any user.
- The box's bootstrap (systemd unit, its identity) with no secrets in it.
- AWS: launching the boxes (the current key cannot create or list resources).
- Codex subscription turns (they reach ChatGPT through a Cloudflare egress path).
- Measure per-turn memory on a real box to set `YTIMESY_TURN_BOX_CAPACITY`.

## Sizing

`t3.small` (2 vCPU, 2 GB, ~$15/month + ~$8 disk) fits roughly 8-10 concurrent
turns. A `t4g.small` is ~20% cheaper but the Claude runner boxes are x86
(pinned x64 Claude binary), so ARM needs a test box first. Size the fleet from
measured concurrency.

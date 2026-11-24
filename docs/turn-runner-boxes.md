# Turn runner boxes

Decision (2026-11-15): API-connection turns (and, since stage 3, Codex and Grok subscription turns) run their
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
  `YTIMESY_BOX_TURN_USERS` (ids, or `*`), the turn is not a Claude Code turn
  (API keys and, since stage 3, the Codex and Grok plans qualify), and a box with
  room registered in the last 45 s. Otherwise the turn runs in its chat's object exactly as before, so a
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
(stage 1; the Codex and Grok subscription routes were added in stage 3, see
"Subscription routes"). The edge reads the turn's own `connection_id` (never the box's),
decrypts it, and streams to the provider's official origin (OpenAI, Anthropic,
Google, OpenRouter; `compatible`/custom hosts and any other origin are refused before any
upstream call; the subscription routes have their own fixed origins). Bodies are
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
  connection only; since stage 3 the loop does not plan one on a box either (see
  "Subscription routes"): a failing route ends the turn with its own message.
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
(`transportBaseUrl`). Subscription connections use the same proxy since stage 3.

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
| `hasManagedCodexAuth` | op `codexAuth`, asked once per turn | (b) stage 3 |
| `warmCodexSubscriptionCatalog` | no-op on a box (the edge reads the catalog when it chooses the model) | (b) stage 3 |
| `pinnedClaudeRunner`, `claudeSubscriptionStatus`, `turnBoxToolIdentity` and its two writers | | (c) Claude Code never runs through a box turn: throw |
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
evaluation, Claude Code, cross-chat memory, helper chats, failover to
another connection mid-turn. (Codex and Grok subscription routes run on a box
since stage 3.) The edge's `finalize` post-work is not retried.

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
running turn can arrive up to 10 s later than in the Durable Object). That includes a released queued message (`message_thread` steer, the composer's Send) and `agent_send` steering. One step reads at most 16 takeable inbox rows (`PEER_INBOX_STEP_READ_LIMIT`), oldest first; queued sends still waiting for Send are not read, so they never hide a released or steering row behind them, and more than 16 deliverable rows are taken in order over the next steps.
The target of ~100 for 40 steps is met in this run, with a floor of one model
request and one checkpoint per step. Not in this number: time-based costs
(with no socket, a lease renewal and a room-lease renewal about every 10 s
and progress writes; with the socket, renewals and progress are socket
messages, 1/20 of a request), and checkpoints a real tool-heavy step would
add (the fake tool returns at once).

## Subscription routes: Codex and Grok on a box (stage 3, 2026-11-18)

Still behind `YTIMESY_BOX_TURN_USERS` (empty: nothing is routed). Nothing here ran
against a real Worker, ChatGPT, xAI or box; the tests use the fake edge, the
real Codex transport over a fake upstream, and the real `runApiTurn`.

**Decision: the edge holds the tokens and sends the request.** A box never
receives an OAuth token, a refresh token or the ChatGPT account id. It sends the
model request to the model proxy like an API-key turn, and the proxy sends it
upstream exactly as the Durable Object's transport does, because it calls the
same code: `subscriptionFetch` (Codex: token read and rotation from the vault,
one forced refresh and resend on 401, the VPC egress and relays and their
failover, `codex.response_headers` logging, the pinned
`PINNED_CODEX_CLI_VERSION` for `codex.catalog`) and `xaiSubscriptionFetch`
(Grok: bearer injection, one refresh on 401, status records). Reachability
(chatgpt.com answers a JSON 401, not a bot challenge, from an AWS IP) would
allow direct egress from a box; it is not used, because that would put a token
on the box. The stream passes through the Worker (below), so nothing blocked
the proxy design.

**What the box sends** (the request the Durable Object's SDK builds):
`POST <edge>/box/v1/model/codex/responses` (Codex) or `.../chat/completions` /
`.../responses` (Grok), the JSON body, `content-type`, `accept`, the grant as
bearer, and for cache routing `session-id` (Codex; a SHA-256 the edge computed)
or `x-grok-conv-id`. For a Codex turn it first asks two port ops, once each per
turn: `codexAuth` (is there a sign-in) and `codexSelection` (the catalog row of
the chosen model, the effort, the cache key). The edge reads the catalog and
makes the plan checks (model offered, fast mode, larger window, effort) with
`selectCodexModel` (domain, shared with the Durable Object) and returns that
row; the box builds the same runtime (`codexSubscriptionRuntime`: request
settings, `store: false`, `parallelToolCalls`, native compaction, `streamOnly`).
The box's transport insists on the exact destination
(`<edge>/box/v1/model/codex/responses`), as the Durable Object's does for
chatgpt.com, and applies the same response checks (`guardCodexInference`). A
Grok turn loads its connection through `modelConnection` (credential removed,
`subscription` kept) and builds its runtime like any API turn.

**What the edge adds:** `Authorization: Bearer <access token>`,
`ChatGPT-Account-ID`, `User-Agent: ytimesy/1.0` (Codex). Whatever the box sent in
those slots is dropped: only `accept`, `content-type`, `openai-beta`,
`anthropic-*`, `session-id`, `x-grok-conv-id` and `x-session-id` are forwarded.
The upstream URL is fixed (`https://chatgpt.com/backend-api/codex/responses`
only; for Grok the connection's `api.x.ai` base, checked with
`isXaiDirectEndpoint`), and redirects are refused.

**Request and response at the Worker.** The request body is read to a string
(up to 8 MiB, the relay's cap) because a 401 must be resent after the refresh
and the Codex egress fails over between paths only for a body that can be sent
again; this is the one place the proxy buffers, and the Durable Object holds
the same body as a string. The response is handed through as a stream
(`new Response(upstream.body)`, no transform, no read): the proxy test checks
the first chunk arrives while the upstream is still open. The client's abort
reaches the upstream (`request.signal`): Stop mid-stream aborts the edge's
upstream request (tested). Worker work is the grant check, the `api_turn`
connection read, the body read and the token read. **Two Worker requests per
step** (model + checkpoint), measured as exactly 2.0 marginal in
`box-subscription-turn-e2e.test.ts`; `codexAuth` and `codexSelection` add 2 per
turn. A subscription is a prepaid plan: the proxy takes no API token
reservation (the Durable Object skips the budget for them too) and needs no
Content-Length.

**Failure handling.** The same typed errors reach the loop, so the user-facing
text is unchanged:

| At the edge | Crosses as | The box throws | User sees |
|---|---|---|---|
| 401 | refresh once, resend (invisible to the box) | | |
| refresh rejected (`CodexReconnectRequired`) | `403` + `x-ytimesy-subscription-error: codex-reconnect` (or in the `codexSelection` answer when found there) | `CodexReconnectRequired` | "Codex login refresh failed; reconnect Codex in Settings → Agents..." (tested, exact text) |
| every egress path blocked | `503` + `codex-egress` + path ids and reasons | `CodexEgressUnavailable` | as today |
| Grok `XaiSubscriptionUnavailable(reason)` (reconnect, not-eligible, usage-limit, unavailable) | `403` + `xai-<reason>` | same class and reason | "Your Grok sign-in expired..." etc. (tested) |
| spent plan allowance (429 with a reset time), empty 200 body | passed through | `guardCodexInference` (shared with the Durable Object) | "...usage is used up. It resets in 2 h..." (tested); an empty 200 is resent by the SDK |
| no sign-in at turn start | `codexAuth` false | the loop's own check | as today |
| any other upstream failure | `502` | an SDK API error | as an API-key turn |

No token, account id or upstream error body crosses in these codes.

**Rate-limit and usage headers.** The proxy passes `x-codex-*`, `x-models-*`,
`x-oai-*`, `openai-*`, `x-ratelimit-*`, `ratelimit*`, `x-xai-*`, `x-reasoning*`,
`retry-after`, request ids and `content-type` (never `set-cookie` or `cf-*`).
The loop reads none of them today; the names are logged by the edge's
transport (`codex.response_headers`, hourly per isolate), as in the Durable Object.

**Failover: not served on a box (decided).** Failing over to another connection
plans from the database (`planModelFailover`), which a box cannot reach. A box
turn whose route fails (a Grok plan that cannot serve, a Codex usage limit...)
is not planned a failover: the loop skips it when `ports.modelAccess` is set
(only on a box) and ends the turn with the failure's own message, as a box API
turn already did (the planning call failed on the box and was swallowed).
Same-route retry of a transient failure still runs. The turn is not moved to the
Durable Object; a user who relies on failover for Codex or Grok stays off the
flag.

**Routing.** Codex turns were kept in the Durable Object by `eligibleForBox` in
`adapters/api-turns.ts` (`subscriptionTurnSettings`), not by `boxTurnBlock`; that
test is removed, so Codex and Grok turns are eligible, and the blocks of
`boxTurnBlock` (helper chats, evaluation runs, runtime secrets) apply to them
as to any turn. Claude Code stays out (`isClaudeCodeRevision`). (A Grok turn had
been routed to a box and refused by the proxy; it now runs.)

**What stays in the Durable Object:** Claude Code turns, helper chats,
evaluation runs, projects with runtime secrets (unless
`YTIMESY_CLAUDE_BOX_TOOLS_SECRETS=1`), every turn when no box is alive or the
user is not in the flag, and the model catalog, usage and connection endpoints
used by the app (they are not turns).

**Risks.** (1) The Worker's `CODEX_EGRESS` binding is used from the box routes
through `withCodexSubscriptionEgress` (`turn-box-worker.ts`); untested against
the real binding. (2) The account id is not pinned for the turn on a box (the
Durable Object passes it to detect a reconnect to another ChatGPT account
mid-turn): the edge uses the account at each request; at worst a cache miss.
(3) `send` runs in its own database scope after the authorize read: a
connection held for the time to response headers. (4) `codexSelection` uses the
isolate-local catalog cache; a cold isolate reads the catalog from ChatGPT.
(5) Native compaction (`/codex/responses/compact`) is not served, as in the
Durable Object. (6) `authorizeTurnBoxModel` (which route a turn is) is tested over a mocked
database (`turn-box-edge.test.ts`), the e2e test builds the same `send` by hand.

**Tests:** `box-subscription-turn-e2e.test.ts` (real `runApiTurn`, fake edge and
upstream, database mocked to throw): Codex and Grok turns complete with zero
database reads; none of the tokens or the account id appears in anything the box
sends or receives (every request and response but the model stream) and no secret
environment variable is read; the edge sets bearer, account, `session-id` and
`User-Agent`; 401 refreshes once (one model request from the box); a rejected
refresh gives the reconnect message; a spent allowance the usage-limit message;
Grok's refusal its own message with no database call; Stop mid-stream cancels
the turn and aborts the upstream request; 2.0 Worker requests per step.
`turn-box-model-proxy.test.ts` covers paths, the header allowlist, pass-through
streaming and the codes.

## Runner identity renewal and enrollment boundary

An updated runner opts in on its normal registration heartbeat. With at most
one hour left, a successful heartbeat can return a new 24-hour identity for
the same signed box ID. The edge checks the revocation-aware registration
write and rechecks expiry before signing. Old runners still receive `{ ok: true }`.
The replacement is sent in a non-cacheable response, kept in process memory,
and used for subsequent heartbeats and claims. No private key goes to the runner.

This is bearer renewal, not proof of instance identity or single-use token
rotation. An old token remains usable until expiry or box revocation; a copied
valid token can renew in the same window. Revoke the box ID and retain its
revocation row if compromise is suspected; do not reuse that ID.

Renewal covers a continuously running trial box, not restart recovery. A
restart uses the originally provisioned identity; if that credential has expired
(or the box missed its renewal window), it must be enrolled again. `aws-trial-1`
cannot recover with its expired identity. After separate approval, bootstrap a
replacement with a distinct ID and a fresh per-box credential delivered through+a controlled, non-logging channel. Do not copy a running box’s token into an
image or launch template. Durable restart recovery and autoscaling enrollment
are separate work: verify each new instance’s identity, enroll it under a unique
revocable box ID, and protect credential delivery and storage. The heartbeat
does not provide those guarantees.

## The fleet on AWS (2026-11-21)

`infra/turn-box/fleet.py` keeps an Auto Scaling group `ytimesy-turn-box`
(default 2 to 6 `t3.small`, us-east-1) on a launch template that holds no
credential. Each box runs `infra/turn-box/bootstrap.sh` once; the systemd unit
then runs `start.mjs` (as root) before every start of the box process:

- **Enrollment.** The box signs an STS `GetCallerIdentity` request with its
  instance role's short-lived keys (`sigv4.mjs`) and posts only the signature
  headers to `POST /box/v1/enroll`. The edge builds the request itself (fixed
  URL and body), sends it to STS, and accepts
  `arn:aws:sts::<TURN_BOX_AWS_ACCOUNT_ID>:assumed-role/<TURN_BOX_AWS_ROLE, default ytimesy-box>/<instance id>`.
  The instance id becomes the box id (revocable as any other); the answer is
  a 24-hour identity. `x-ytimesy-audience` is signed into the request, so a
  signature made for anything else is refused. Off (404) without
  `TURN_BOX_AWS_ACCOUNT_ID`.
- **Program.** `GET /box/v1/bundle` (identity only) answers a five-minute R2
  link and the SHA-256 of the current program, which
  `scripts/publish-turn-box.ts` uploads (`turn-box/<hash>.mjs.gz`, then the
  manifest `turn-box/latest.json`). A restart picks up a new program.
- **Identity loss.** A rejected identity (401) makes the process exit
  (`YTIMESY_BOX_EXIT_ON_REJECTED=1`); systemd restarts it and `start.mjs`
  enrolls again. The heartbeat also renews an identity in its last hour.
- **Logs.** The process logs to `/var/log/ytimesy-turn-box.log`, shipped to
  CloudWatch `/ytimesy/box` (14 days) by the agent with the instance role; it
  logs its memory every five minutes.

## Everything a root chat uses, on a box (2026-11-21)

The box runs the product's whole tool surface; what needs the database, a
credential or a record the box must not hold goes through the edge, checked
against the turn's own user, chat, helpers, project and VM. The box test
`box-turn-e2e.test.ts` ("every product tool on a box") runs each offered tool
with a real shell as the VM and the database mocked to throw, and pins the
offered tool list, so a new tool fails it until it is checked here.

- **Helpers** (`agent`, `agent_send`): the tools run on the box; their
  database and helper-VM operations (`SubagentToolDeps`) are the `subagent`
  port (`turn-box-subagent-port.ts`). Every chat must be the turn's chat or a
  descendant, every VM one of theirs, a fork named for one of them; records
  cross as ids and are reloaded on the edge. The helpers themselves run in
  Durable Objects (routing keeps helper chats off boxes). A box polls a
  helper's report no more than every 5 s. Lead mode fusion is kept off boxes.
- **MCP**: `mcpListing` gives the turn's tools as data (no URL, header or
  token), once per turn; `mcpCall` connects the edge to the named server of
  the turn's own user and project for that one call. A failed listing leaves
  the turn without MCP tools, as in the Durable Object.
- **Memory**: the `memory` port (`turn-box-memory-port.ts`) runs
  `turnMemory` on the edge for the chat's own VM: instructions, the clone (its
  short-lived token comes back to the box only for redaction), the recall
  parts (the box adds them to the request), the saved-lines marker, release.
  The save hook is queued by the edge after finalize.
- **Tool receipts** (bash, write, edit, run_code, completion checks): the
  adapter asks `remote-command-receipts.ts` first; the box registers its
  running chat there, so receipts go through the `commandReceipt` port.
- **Canvas** revisions: the `canvasRevision` port.
- **Run whole on the edge** (`remoteTool`, `turn-box-tool-port.ts`): saving
  a secret (its value is read on the chat's VM by the edge and never passes
  through the box), describing one (checked against values only the edge
  holds), asking for a push approval, saving the environment setup. Push
  cards answered meanwhile are claimed through `pushNotices`.
- **Routing**: lead mode fusion, side chats (children without a role),
  evaluation runs and Claude Code stay in Durable Objects. Y² chats and
  helpers with a role run on boxes (next section). `YTIMESY_TURN_BOX_SECRETS=1` lets chats whose project or
  account holds runtime secrets run on a box (the VM redacts its own output),
  without changing the Claude runner's `YTIMESY_CLAUDE_BOX_TOOLS_SECRETS`.

Still not on a box: the @mention note
(`withMentionNote` reads sessions; it degrades to no note).

- **Plain git on the VM.** The edge holds the git proxy's signing secret, so
  the `machineGit` port mints the step's machine token and sets git up on the
  chat's own VM (turn-box-machine-git-port.ts); the box only gets the token
  back to redact it. The box releases it at the end of a step that set it up;
  after finalize that release is refused (no lease), so the edge also releases
  it (scrub and revoke every token of the chat) when the turn settles.
- **No per-turn state on the edge between requests.** A Worker cannot settle
  a promise created by a request that has ended, so the memory port builds
  the turn's memory in every request instead of keeping it (it once failed
  recall with a 503 for exactly that reason).

## Sizing

`t3.small` (2 vCPU, 2 GB, ~$15/month + ~$8 disk) fits roughly 8-10 concurrent
turns. A `t4g.small` is ~20% cheaper but the Claude runner boxes are x86
(pinned x64 Claude binary), so ARM needs a test box first. Size the fleet from
measured concurrency.

## The super agent and helpers on a box (2026-11-22)

- **Y²** (`ySquared` port, `turn-box-y-squared-port.ts`): the box runs the Y²
  tools; their Deps (thread list, metadata, outcome, canvas, attachment
  download, send, stop and the project crew's list, thread, reconcile,
  sent-note and schedule) are port calls. The edge serves them only when the
  turn's chat is its project's Y² chat; every user is the turn's, every
  project the chat's, a named thread must be a root chat of that project and
  not Y² itself, a send or stop uses that thread's harness and the edge's
  machines, a schedule is always this Y² chat's.
- **Helpers with a role** run their own turns on boxes. Each step's budget
  count and their helpers' token use are the `helperStep` port; their
  read-only memory (`search_memory`, `read_memory`, the recall parts) is the
  `helperMemory` port, built on the edge in every request. Their report to
  the parent comes after finalize, so the edge writes it when the turn settles
  (`settleHelperReport`: final words or failure, a writer's patch moved with
  the edge's machines, the task result saved and its event queued); the box
  skips that block (`helperReportsAtSettle`). Plain git, the server-run tools
  and the git-token release now serve helper chats too.
- **Still in Durable Objects:** side chats, lead mode fusion, evaluation runs,
  Claude Code turns (their loop is the CLI on the Claude runner).
- **Model failover** works on a box: a failing route asks the edge for the
  plan (`planFailover` port: `planModelFailover` on the turn's own row, with
  the user's connections and preferences), the box checkpoints the switch as
  the Durable Object does, and the edge's model gateway
  (`authorizeTurnBoxModel`) serves the turn's failover route from then on.
  Without it a Y² turn on a spent Grok plan failed instead of moving to the
  next model (2026-11-22).
- **Long chats and a failover's route across steps.** A box gzips a request
  body over 256 KB (`content-encoding: gzip`); the edge holds the compressed
  body to 8 MB and inflates it to at most 64 MB. A checkpoint or finalize the
  edge refuses now fails the step: a Y² chat's 8.3 MB history was once refused
  (413) on every checkpoint and the box carried on, and since its failover was
  never saved each step started on the spent route again (a loop, stopped by
  hand on 2026-11-22). The box also keeps the failover it checkpoints on its
  own turn identity, so the next step runs on the fallback route.
- **The chat's coordination lease across short steps.** A box acquires the
  chat room's 30 s coordination lease once per turn; a later step's acquire
  now renews it when 10 s have passed. Before, only a step's own heartbeat
  renewed it, and only after 10 s inside the step, so a helper whose steps
  were all shorter let it lapse and was stopped mid-turn (2026-11-22).

## Claude Code on a box (2026-11-22)

Measured before the move: Claude Code turns were ~85% of the chat objects'
billed duration (three Claude chats: ~160k of 189k awake-seconds in 48 h, at
almost no CPU). The object stayed awake holding the run's MCP requests while
tools ran and awaiting the runner while Claude worked. Now a root chat's
Claude Code turn can run its step on a turn box, per user:
`YTIMESY_BOX_CLAUDE_USERS` (ids or `*`; helpers and side chats stay in the
object).

- **The box holds no secret.** The edge's `claude` port
  (`turn-box-claude-port.ts`) chooses the chat's runner (and pins it in the
  chat's object, `claudeRunnerPlacement`), signs every `/exec`, `/write`,
  `/read` for it with the runner key (only a configured runner or the chat's
  pinned one), mints the run's grant (marked `relay: "box"`), and reads/writes
  the chat's Claude session record, transcripts and plan status. A reader
  chat never gets a runner whatever the box says.
- **MCP relay** (`claude-relay.ts`): the run's CLI calls
  `/claude-code/mcp` as before. For a box grant the edge Worker holds the
  request (stateless, no duration) and opens a hibernatable socket to the
  chat's object; the object stores the call and pushes it over the box's own
  turn socket (`claude-call`), resending until the box acks. The box queues it
  in its local bridge and takes it at once; its `claude-reply` goes back to
  the call's socket. The box publishes the run's tool list (`claude-tools`)
  for `tools/list`. The box client reopens its socket while a Claude step
  listens, and replays answers written while it was down.
- **No feed, no park on a box:** polls wait on the runner for new output (up
  to 20 s, at most one a second while Claude streams), so a quiet run costs
  one edge request per ~20 s and the object nothing.
- Deploy order: edge first (it accepts the new socket messages), then the
  box bundle, then the switch.
- Tests: `claude-relay.test.ts`, `turn-box-claude-port.test.ts`,
  `box-claude-turn-e2e.test.ts` (whole turn through the real routes and relay,
  including a socket dropped before the call).
- **Hand-off to the object** (`handToObject`, 2026-11-22): a claimed turn
  whose history is over 8 MB (`TURN_BOX_HANDOFF_HISTORY_BYTES`; the box limit
  is 16 MB), or whose VM cannot redact the account's runtime secrets itself
  (a fresh VM: its first turn), is queued again for its chat's Durable Object
  instead of failing: the edge releases the box's coordination lease, queues
  the turn, then sets its executor (an admitted turn's executor is
  immutable), and the admission sweep starts it. The box hears lease-lost.
- **The chat's lock across a change of owner** (2026-11-23): the hand-off lets
  the chat's coordination lease go with `handoff`, which does not retire the
  turn, and then runs an admission at once (the turn no longer waits up to a
  minute for the sweep). The room retires a released or lapsed lease by
  turn *and lease* (`retiredLeaseKey`): every claim gives the turn a new
  lease that Postgres checks on every write, so the turn's next owner (the
  object after a hand-off, a box after a takeover) is never refused for its
  predecessor. Retiring the turn ID refused them for 70 s; the object's
  35 s acquire gave up and the chat showed "could not confirm this turn's
  ownership" (chats 3b8ac257 and f4c33192, a new chat's first turn). A
  turn's first step waits up to `TURN_START_WAIT_MS` (105 s) for the lease,
  rides out the coordinator restarting, and ends as stopped (not failed)
  when Stop came meanwhile. Tests: `tests/conversation-room-handoff.test.ts`,
  `api-turn.test.ts` ("a turn that cannot take its chat's lease at once").
- Live (2026-11-22): a Claude Sonnet turn ran on a box with one relayed
  `bash` call; a fresh-VM chat was handed off and completed in its object.
  Switch: `YTIMESY_BOX_CLAUDE_USERS=*`.

## Thread status from box turns (2026-11-23)

The edge tells the chat's object when a box turn starts (claim) and settles
(finalize), `noteBoxTurn`, so the crew (Y²) and the user's hub hear it. Two
gaps kept threads "working" there:

- The object read its crew scope through the turn's durable-object lease, so
  for a box turn it found none and sent nothing (logged `crew.note …
  skipped: "no-scope"`). It now reads it by the chat
  (`readChatCrewScope`), at each box start and at any settle with none.
- A turn the lease sweep fails (`expireApiTurnLeases`: a box out of
  takeovers, a dead object) settled in Postgres only. The sweep now tells
  the chat's object (`noteTurnsSettledElsewhere`), which sends the notes.

The crew's stall signal reads the turn's real progress (last checkpoint or
progress write, last renewal) before calling a thread stuck (docs/y.md,
"Stall / follow-up signals").

## Deploying while turns run (2026-11-23)

- **One slow renewal never ends a turn** (2026-11-24): two box turns died at
  18:41 UTC on "coordination failed during renew (timeout, 1 attempt)". The
  edge's pool of two database connections was busy: every box port call,
  even the chat's lock renewal, first loaded the whole turn row (megabytes
  on a long chat), and the renewal waited for a free connection past the
  box's single 8 s attempt ("Timed out while waiting for an open slot in the
  pool", op coordinateTurn). Now the lock calls read the turn's identity
  only, the box repeats each of them (3 attempts of 6 s with 0.3 s and 1 s
  between, 19 s in all, inside the 30 s lease), and a renewal that still
  fails after the grace window first asks the database whether the turn
  owns its lease and takes the lock back (`resume`) before stopping it.
  Only a real outage stops a turn. No production Worker changed at that
  moment (the 18:32 deploy and the 18:45 one bracket it; the Alchemy work
  touched the development Worker only).

- **Cut connections resume, they do not fail** (2026-11-23 evening): a deploy
  cuts a chat object's outbound calls about a second before resetting it
  ("Network connection lost."), and resets a box's requests to the edge
  (ECONNRESET, "fetch failed"); the edge answers a box's workspace request
  503 while the machine provider is briefly down. A step that hits any of
  these (`isCutConnection`, `isEdgeOutage` in api-turn.ts) is not settled: it
  rethrows like a platform reset, its executor retries it from the checkpoint
  (3 times), and a Claude Code run is left running for the resumed step to
  re-attach to (`leavesClaudeCodeRunning`). Each logs `turn.interrupted`
  (cause reset, connection or edge-outage). Measured before the fix: 3 turns
  failed at deploys in 48 h (21:03, 21:16, 21:31 on Nov 23) and 4 box turns
  on edge 503s.

- **Edge and web deploys** restart chat objects (each moves to the new code
  once idle or after a delay). A turn rides that out: a failed coordination
  renewal is retried for up to 20 s of the 30 s lease
  (`COORDINATION_HEARTBEAT_GRACE_MS`; the lease is in the object's storage),
  the box's socket falls back to HTTP and reconnects, and a relayed Claude
  call reconnects for the same call (the object keeps an answer meanwhile).
- **A Claude turn's MCP calls through its chat object** (2026-11-23): an
  object reset (a deploy, or its isolate out of memory) failed every MCP
  POST it held, and the edge answered an empty 503, which Claude Code shows
  as "Error POSTing to endpoint:". The edge (`forwardClaudeCodeMcp`) now
  sends again, up to 3 times, only what is safe to repeat
  (`claude-code-mcp-retry.ts`: protocol messages, read-only tools, and
  `start_thread`/`message_thread` deduped by their send key, but not
  interrupt). Anything else gets an MCP answer naming the hop and the cause.
  A relayed call's socket that cannot open is reopened for the same call id.
- **Box program updates** need no instance refresh: `scripts/publish-turn-box.ts`
  is the deploy. Every registration answers with the published version
  (`latestVersion`, read from the manifest at most once a minute per edge
  isolate); a box on another version takes no new turns, finishes the ones
  it holds (and any claim in flight), then exits, and its service starts it
  again on the published program. Other boxes take new turns meanwhile.
  An instance refresh (which kills running turns; another box takes them
  over after 45 s) is only for launch template changes.

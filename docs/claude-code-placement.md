# Where Claude Code runs (decision, 2026-11-02)

A chat on a Claude subscription runs the real `claude` program (through the
Claude Agent SDK) **on that chat's own Freestyle VM**, with Claude Code's
built-in tools (Bash, Read, Edit, Write) working on the checkout. It does not
run on a separate machine. Code: `src/server/services/claude-code-runner.ts`,
`src/domain/claude-code-proxy.ts`.

Read this before proposing to move Claude Code off the chat VM, to a runner
pool, or into a container. That design was considered and turned down; the
reasons and the costs accepted are below.

## The two designs

| | Same VM (chosen) | Separate runner pool (rejected) |
|---|---|---|
| Where `claude` runs | the chat's VM | shared runner VMs that only host `claude` processes |
| Claude Code's tools | its own built-ins, natively on the checkout | built-ins off; every tool rebuilt over MCP and sent to the chat VM |
| New infrastructure | one proxy route on the edge | a runner fleet to build, scale, isolate and keep alive |
| Chat VM lost mid-turn | the whole turn is lost (see below) | only the current tool call fails; Claude carries on with a new VM |

## Why the same VM

The only reason to keep Claude off the chat VM was **the user's Claude token**.
The chat VM runs untrusted repo code with `sudo`, so a token on it could be
stolen. That was solved the way the GitHub token is: the VM only gets a
signed, short-lived per-turn grant as Claude Code's login, plus
`ANTHROPIC_BASE_URL` pointing at our edge, and the edge checks the grant and
swaps in the real token from the vault. A local test on 2026-11-02 confirmed
Claude Code sends its requests, with whatever token it was given, through a
custom `ANTHROPIC_BASE_URL`.

With the token handled, the same VM was simpler:

- Claude Code's own tools work unmodified. Claude is trained on them, and
  rebuilding each one over MCP would add work, a network hop per tool call,
  and a quality risk.
- There is no separate fleet to run.

## What it costs (accepted, not solved)

Disposability holds **between turns only**:

- **A VM lost mid-turn loses that turn.** The Claude Code transcript (session
  JSONL) is uploaded only after a run finishes. A new VM resumes from the
  previous turn's transcript; the lost turn's reasoning, tool calls and file
  edits must be redone.
- **A failed transcript save only logs a warning.** The next turn on a new VM
  then starts without the conversation, and nobody is told.
- **A running turn keeps the VM awake.** The VM suspends 180 s after it goes
  idle (`PRODUCT_IDLE_TIMEOUT_SECONDS`). In a normal turn the model calls tools
  every few seconds to a minute, so a separate runner would rarely let it
  sleep. Money is not the deciding difference; durability is. (Rough
  2026-11-02 Freestyle estimate: a Large chat VM about $0.37/h; a runner
  slot about $0.006–0.012 per process-hour.)

## When to revisit

Revisit if losing VMs mid-turn becomes common, or if turns spend long
stretches (over 3 minutes) thinking between tool calls. A cheaper first step
than a runner pool is saving the transcript during the turn, not only at its
end.

## Update 2026-11-10: runner boxes, behind a flag (off)

The decision above stands: by default `claude` runs on the chat's VM. Code now
exists to run it on a **runner box** instead, because a chat VM lost or reset
mid-turn took the whole turn with it, and the VM also runs untrusted repo code
with `sudo`. Nothing is enabled or provisioned until the settings below exist.

- **The split.** `claude` runs on a small AWS box that holds no repository
  (`infra/claude-runner-box/server.mjs`: signed `/exec`, `/write`, `/read`,
  confined to its home, the delivery signature plus a single-use nonce). The
  chat's Freestyle VM is only the workspace: Claude's own Bash/Read/Edit/Write/
  Glob/Grep/Task are off (`CLAUDE_RUNNER_DISALLOWED_TOOLS`) and ytimesy's file
  and shell tools, plus `run_code`, are served over the existing MCP bridge and
  run on the VM. Claude's own TodoWrite stays; the chat already shows it
  (`claude-code-stream.ts`), so ytimesy's `update_plan` is not offered.
- **Settings** (`src/domain/claude-runner.ts`): `YTIMESY_CLAUDE_RUNNER_URLS`
  (comma-separated HTTPS origins), `YTIMESY_CLAUDE_RUNNER_SIGNING_KEY` (the
  edge's Ed25519 private key; the boxes hold only its public key, see
  "Runner box signatures" below) and, until the rollout there is finished,
  the legacy `YTIMESY_CLAUDE_RUNNER_SECRET` (32+ chars, the same as the boxes'
  `RUNNER_SIGNING_KEY`), `YTIMESY_CLAUDE_RUNNER_USERS`
  (user ids, or `*`). A chat always maps to the same box (hash of its session id): the
  chat's Claude session file lives on that box between turns and can reach
  hundreds of MB, far past the 20 MiB saved to storage, and each step of a
  turn finds the process it started. Read-only helpers stay on the VM.
- **Code mode** is on for these turns whatever the harness variant says: each
  tool call is a network hop, and `run_code` batches them. The prompt
  (`claudeRunnerPrompt`) says when to use it; whether Claude actually uses it
  is not measured yet, so count `run_code` calls and adjust the prompt.
- **Disposable.** The session transcript is saved every minute while the run
  goes (not only when it ends), so a lost box can be replaced and the turn
  resumed from it. Failing over to another box is **not built**: today a turn
  stays on its box.
- **Disk.** Sessions of 250 MB fill a small volume quickly, so a box gets a
  100 GB volume (`infra/claude-runner-box/provision.py --size-gb`) and a
  15-minute timer (`cleanup.mjs`): session files idle over 7 days go, run
  directories over 3 days go, and above 85% disk use the least recently used
  sessions are evicted down to 70%, never one touched in the last hour. An
  evicted session on a chat's box falls back to the saved copy, which cannot
  hold a large one. Not run on a real box yet.
- **If the disk still fills.** `GET /health` (no signature) reports
  `disk.usedShare`, and the box logs a warning above 80% (its `/health` and the
  cleanup run). The edge asks `/health` before it starts a new run and refuses
  one at 95% or more with "its runner is full (the disk is almost out of
  space), so it did not start"; later steps of a run in progress are not
  blocked, and a `/health` that cannot be read never blocks a turn. The volume
  grows live: `grow-volume.py --instance i-... --size-gb N` (EBS can grow, not
  shrink, one change per 6 hours) and the box's root `ytimesy-grow-root` timer
  grows the partition and filesystem within 15 minutes. Nothing pages anyone
  yet: the warning is in the box's journal.
- **Changing the box list moves chats to other boxes** (the box is a hash of
  the chat id over the list). Persist each chat's box before ADDING a box
  (scale-out). For a move to another backend it can be backfilled then, by
  recomputing each chat's box from the old list, provided the hash and the old
  list are kept until it is done.
- **Not done / not measured:** provisioning the boxes and their HTTPS names
  (Cloudflare Tunnel is the plan); tool-call latency over the extra hop on a
  real network; memory and CPU per `claude` process (about 200 MB resident in
  the localhost benchmark); how Claude behaves with ytimesy's file tools
  instead of its own; drain on scale-in. The box image needs Node at
  `/usr/local/bin/node`, python3, and the pinned Agent SDK installed at the
  path `src/domain/guest-cli-pin.ts` names.

### Provisioned 2026-11-10 (flag still off)

Two boxes in AWS account 703705584492, us-east-2: `i-00abdba63343ac96b`
(`runner-1.ytimesy.com`) and `i-071ce164aa7ae12c4` (`runner-2.ytimesy.com`),
each a `t3.small` (x86_64, like the chat VMs: the pinned SDK path is the x64
build, so an ARM `t4g` box fails its bootstrap), 100 GB gp3, no inbound ports,
reached through Cloudflare Tunnels `ytimesy-runner-1/2` (ids
`480072d7-c988-433a-b043-334995744949`, `f85224d0-6980-4913-add3-2a1aab73fb10`;
DNS CNAMEs, proxied). Verified through the real edge client on both: signed
`/exec`, `/write`, `/read`, a wrong key answered 403, Node 22.11, Python 3.12,
the SDK ready check passes (claude 2.1.321), the cleanup and grow timers are
installed, `/health` reports the disk. Round trip from the build machine
through Cloudflare was 270-630 ms for a trivial command (not measured from the
edge Workers). The signing key is only on the boxes (`/etc/ytimesy-runner.env`)
and, once the flag is turned on, in the Workers' `YTIMESY_CLAUDE_RUNNER_SECRET`.
(Superseded 2026-11-16: the key is also in each box's EC2 user data, and the
boxes move to Ed25519; see "Runner box signatures".)

### Workspace tool lifecycle hardening (2026-11-10, pending deployment)

The native-tool descriptions above are historical: new Claude runs now disable
native workspace and agent/task tools on **both** hosts, including Bash and its
background-task readers/stoppers. The MCP bridge offers ytimesy workspace tools
and `run_code` on either host. Commands therefore use the existing owned job
registry, completion notices, cancellation and output controls instead of a
second Claude-native background-job system. TodoWrite remains native and
ytimesy's plan tool is omitted, including from the tools callable by code mode.
Read-only helpers keep their existing owner-scoped read-only workspace tools.
Native web tools are unchanged.

A platform reset also leaves the turn's queued MCP bridge calls available to
the next step, rather than incorrectly replying that the turn has ended.
Ordinary failures and user Stop still close queued calls. A tool-response
timeout distinguishes work removed before execution from work already started:
started work has an unknown outcome and must be inspected, not blindly retried.

These settings apply when a new Claude process launches. They do not import
old Claude-native background jobs, restart active processes, or repair their
missing completion records. See `docs/claude-job-lifecycle-hardening.md` for
checks and the unresolved wider reliability work.

### Follow-up hardening (2026-11-10, pending deployment)

- The conversation DO now stores its chosen runner origin in SQLite through
  `ClaudeRunnerPlacement`. The configured hash proposes the first origin only;
  later steps and turns retain the stored origin when the pool changes. Secrets
  are never stored there. Placement is erased on chat purge, not at turn end.
  Removing a box still requires migration/draining; it no longer silently moves
  that chat to a box missing its large session. Keep the feature enabled and its
  existing hosts reachable until their sessions have been migrated.
- Cancellation and failover stop the actual AWS runner process when remote
  mode is selected, even if the Freestyle workspace is unavailable.
- Transcript saving probes the file size on the execution host before reading
  it into the edge. Large local sessions are retained, and a previous valid
  checkpoint for the same session is retained instead of being cleared. The
  20 MiB checkpoint limit is not raised; large-session host-loss recovery is
  still limited to the last checkpoint, if one exists.
- New runner bootstrap units use `KillMode=process`: restarting the API must
  not let systemd terminate every detached agent in the service's cgroup.
  Existing boxes need this unit setting applied before their API is restarted.
  No live boxes have been changed for this follow-up patch.
- The API no longer passes `RUNNER_SIGNING_KEY` into spawned commands, handles
  spawn errors without crashing the server, and times out the entire short-exec
  process group. Detached, independently scoped Claude runs are not members of
  that short-exec group.
- Chat display/delivery pages are bounded by item count and serialized byte
  budget, splitting oversized turns without deleting any stored items. This
  bounds normal delivery batches; it does not yet normalize the execution
  history stored in `api_turn`. A single oversized item remains readable.
  Context usage is selected independently of the page so the context indicator
  survives when the user message is on an older page.
- The SDK records the initialized session ID, and cleanup protects live runs
  and their session files by checking scoped PID/start-tick ownership, including
  while a long tool call leaves the transcript untouched. Stale/reused PIDs do
  not protect old sessions from cleanup.
- Launch/reattach uses a per-run shell lock. The detached child closes its copy
  of the lock descriptor; retries repair a missing current pointer without
  spawning the same run twice.
- Background workspace installation keeps a terminal descriptor open until its
  status file is published and explicitly preserves HOME when reusing tmux.
  Redirecting all standard streams previously allowed tmux to terminate the
  installer before it published completion.

### Live runner maintenance and scoped canary (2026-11-10)

The Worker lifecycle fixes above were deployed as build
`0a0ce5c96012-mwavvhha`. Both existing AWS runners have now been updated with
the matching server and cleanup files and a systemd drop-in setting
`KillMode=process`. Their original root/session volumes were preserved; the
updates used temporary private repair instances after confirming no Claude
processes were active. Both repair instances were terminated afterward.

Live signed checks verified the exact source-file hashes, the active KillMode
and that command children do not inherit the runner signing key. A real Node
process in each runner service's cgroup survived an API restart with the same
PID/start tick while the API acquired a new PID. Those are live process-lifecycle
checks, not real Claude inference or workspace-tool tests.

The optional `YTIMESY_CLAUDE_RUNNER_SESSIONS` setting narrows the existing
account allowlist to comma-separated chat IDs. An absent setting retains the
account rollout behavior; a present empty list enables no chats. `*` is not a
chat wildcard. Account authorization and reader exclusion still apply. This
allows testing one new chat without moving old chats whose newest transcripts
may exceed their encrypted checkpoints. Do not remove this restriction until
the affected existing sessions have been copied and verified on their pinned
runners, or the owner has explicitly accepted starting them without that state.

Canary-gate validation: 59 targeted runner/placement/turn/API/cleanup tests,
full typecheck and production build passed. The gate has not yet been deployed
or activated; no real Claude inference is claimed for this maintenance stage.

### Runner box signatures: Ed25519, no signing key on a box (2026-11-16, not deployed)

Owner's rule: no production secret on any AWS box. Until now the boxes checked
requests with a shared HMAC key (`RUNNER_SIGNING_KEY`, equal to the Workers'
`YTIMESY_CLAUDE_RUNNER_SECRET`): anyone who read it on one box could sign
`/exec` for every box, and it was a Worker secret too. Now the edge signs
each request with an Ed25519 private key that only the Workers hold
(`YTIMESY_CLAUDE_RUNNER_SIGNING_KEY`, base64 PKCS8 DER), and a box holds only
the public key (`RUNNER_PUBLIC_KEY`, base64 SPKI DER).

- **What is signed** is unchanged: `POST`, the path, the expiry (at most 65 s
  ahead), the body's SHA-256 and a 32-hex nonce (`runnerSignedMaterial` in
  `infra/claude-runner-box/server.mjs`, `signedMaterial` in
  `src/server/adapters/claude-runner-box.ts`). The Ed25519 signature travels
  as `x-ytimesy-runner-signature-ed25519` (base64url, 86 characters); the HMAC
  stays in `x-ytimesy-delivery-signature`. A nonce is accepted once until its
  expiry, whichever signature carried it.
- **Edge** (`claudeRunnerFor`, `runnerRequestHeaders`): signs with every key
  it has. With both settings each request carries both signatures; with only
  the Ed25519 key, only that one. A value that is not 64 base64 characters is
  ignored; a well-formed value that does not import fails the call before
  anything is sent (not retried as a network error).
- **Box** (`createRunnerServer`): with `RUNNER_PUBLIC_KEY` it accepts only a
  valid Ed25519 signature, even if `RUNNER_SIGNING_KEY` is still set. Without
  it, it checks the HMAC as before. It logs which one at start
  (`"Runner API verifies"`).
- **Keys:** `node --import tsx scripts/generate-claude-runner-keypair.ts
  --private-key-out <file>` prints the public key and writes the private key to
  a new owner-only file. The owner puts it in the production secret bundle
  (`PRODUCTION_ENV_FILE`) as `YTIMESY_CLAUDE_RUNNER_SIGNING_KEY`;
  `scripts/deploy-production.ts` forwards it to the Workers when present.
  `provision.py --public-key <base64>` gives new boxes only the public key.

**Rollout, in this order:**

1. **Edge sends both.** Add `YTIMESY_CLAUDE_RUNNER_SIGNING_KEY` to the bundle
   and deploy (the usual production deploy). The old secret stays, so every
   request carries both signatures; the boxes, still on HMAC, ignore the new
   header.
2. **Each box: public key in, shared key out.** Per box, in one stop window
   (procedure below): install the new `server.mjs`, replace the
   `RUNNER_SIGNING_KEY=` line of `/etc/ytimesy-runner.env` with
   `RUNNER_PUBLIC_KEY=<public key>`, and clear the copies of the old user data
   (below). Both files must change together: the old `server.mjs` ignores
   `RUNNER_PUBLIC_KEY` and, without `RUNNER_SIGNING_KEY`, will not start.
   Check afterwards that a signed call works and that an HMAC-only request
   gets 403.
3. **Edge drops the HMAC.** Remove `YTIMESY_CLAUDE_RUNNER_SECRET` from the
   bundle and delete it from the Worker:
   `pnpm exec wrangler secret delete YTIMESY_CLAUDE_RUNNER_SECRET --config
   wrangler.edge-executor.jsonc --env production`. Removing it from the bundle
   alone does nothing, because `deploy --secrets-file` only adds and updates
   (`scripts/production-deploy-steps.ts`). The old key is then worthless
   everywhere; treat it as leaked, because it is still in the boxes' user
   data until step 2's cleanup.

**How boxes are built and updated (checked 2026-11-16, read-only).** A box is
stock Ubuntu 24.04 plus `bootstrap.sh` run once as EC2 user data
(`provision.py`). There is no AMI of our own, no SSH (no key pair, a security
group with no ingress), and no SSM (no instance profile; the IAM user here is
also denied `ssm:DescribeInstanceInformation`). The 2026-11-10 update was done
by hand with temporary repair instances. That procedure is not in the repo:
stop the box, move its root volume to a helper in the same AZ, edit, move it
back, start. The signed `/exec` cannot do it: it runs as `ytimesy-runner`, and
the env file is root-owned with `NoNewPrivileges`. The AWS credentials on the
build machine (IAM user `ytimesy_prod_for_codex`, account 703705584492) pass
`DryRun` for StopInstances, StartInstances, DetachVolume, AttachVolume,
ModifyInstanceAttribute and CreateSnapshot on these boxes. So step 2 can be
run from there, after installing boto3 or the AWS CLI (neither is installed).
RunInstances for the helper was not proven. Per box:

1. Make sure no Claude run is live on it. Stopping the box ends its detached
   `claude` processes.
2. Take a CreateSnapshot of the root volume.
3. Stop the box. Move its volume to the helper and mount it. Replace
   `opt/ytimesy-runner/server.mjs` and edit `etc/ytimesy-runner.env`. Delete
   cloud-init's cached user data: `var/lib/cloud/instances/*/user-data.txt*`
   and `var/lib/cloud/instances/*/scripts/part-*`.
4. While the box is stopped, clear its user data with ModifyInstanceAttribute.
   Move the volume back and start the box. Terminate the helper.

**What a box still holds after the rollout:**

- **Cloudflare Tunnel token**, one per box (`ytimesy-runner-1/2`). It is in
  the user data (until cleared), in cloud-init's cache, and in the
  `cloudflared` systemd unit, which passes it as `--token` on the command line.
  Every local user can read that command line through `/proc`. (That is how
  `cloudflared service install` sets up the unit on Linux; it was not checked
  on the boxes.) With the token,
  someone can run a connector for that box's tunnel and receive the edge's
  requests for that box only. They then see the run files the edge writes
  there, including per-turn grants. They still cannot sign a request to any
  box. It is per box, not shared, but it is a production credential. Removing
  it needs a different ingress, for example a public origin restricted to
  Cloudflare with authenticated origin pulls; the box would then hold that
  origin's TLS key instead. Not done.
- **Per-turn Claude grants**: a signed token valid for 6 hours
  (`CLAUDE_CODE_GRANT_TTL_MS`), in `runs/<run>/env` and `mcp.json`. It lets
  the holder call the edge model proxy and that chat's MCP tools. `claude`
  needs it to work, and cleanup deletes run directories after 3 days. Users'
  Claude tokens themselves stay on the edge.
- **Users' session transcripts**: user data, not credentials.
- **No AWS credentials**: there is no instance profile. IMDS (v2, hop limit
  2) is still enabled, and any process on the box can read the user data
  through it, which is why step 2 clears it. Disabling the metadata endpoint
  (ModifyInstanceMetadataOptions, which can be done without a stop) would
  also close that.

Until step 2, any process running as `ytimesy-runner`, `claude` included, can
read `RUNNER_SIGNING_KEY`. It is in `/proc/<API pid>/environ` (same uid) and
in IMDS user data. Removing it from the spawned commands' environment did not
hide it.

Checked: box and edge tests (sign and verify across both implementations,
the double-signed rollout request on HMAC-only and Ed25519 boxes, replay,
expiry, and tampered body, path, expiry, nonce and signature). Ed25519 PKCS8
signing under local workerd (`wrangler dev`) verifies with the printed public
key. Not done: nothing is deployed, and no live box was changed.

## Workspace tools on the box (phase 2a, 2026-11-16, flag off, not deployed)

Each ytimesy MCP tool call of a runner-box run used to go box → edge MCP route
→ the chat's Durable Object, which ran the tool against the Freestyle VM: about
1.5 s awake per call, ~240 calls per turn-hour. Behind
`YTIMESY_CLAUDE_BOX_TOOLS` (`1`/`true`; default off, and off means the old path
unchanged) the box runs the lean workspace tools itself, straight against the
VM, and the object is not woken for them.

**What runs where.**

- **On the box** (`src/server/claude-box-tools/`): the lean shape's own tools
  the turn offers (core: `bash`, `read`, `write`, `edit`; the Claude shape adds
  glob and grep). Same code as the edge: `lean-shape-surface.ts` over
  `apiAgentCommandTools` and `agentOutputArtifacts`, answered through
  `runToolForMcp` (`mcp-tool-call.ts`, shared with the bridge). Nothing is
  copied; to make that possible the lean engine no longer imports its durable
  journal and helper installer (they are given to it: `lean-tools.ts` on the
  edge, in-memory and no-op on the box) and the edit Python moved to
  `edit-scripts.ts`. The bundle (`scripts/build-claude-box-tools.ts`, ~0.9 MB)
  is inlined in the Worker at build time and written once per version to
  `~/.ytimesy/claude-box-tools/<hash>.mjs` on each box.
- **Still on the edge**, through the unchanged MCP route: every other tool
  (agents, plan, canvas, secrets, questions, MCP, web, `run_code`), a command
  started in the background (its exit callback is signed with the edge's
  secret, and raising the VM's idle timeout needs the account key), any
  `ytimesy-browser` or `ytimesy-job` command (captures go to R2/Postgres), the
  inbox and the feed, and a box call the provider refused before running
  anything (paused or replaced VM, revoked grant). `boxCallRunsOnEdge`
  (`src/domain/claude-box-tools.ts`) decides, for the box and for the
  timeline alike.
- **Not offered at all** (all on the edge, as before) when the turn has
  repository tool hooks (`toolHooksConfigured`), a read-only helper, a
  non-lean surface, or no runner box; or runtime secrets and a VM that
  cannot redact them itself (below).

**Runtime secrets are redacted on the VM** (`src/domain/vm-secret-redaction.ts`,
2026-11-16). Their values are already on the VM, in the env file every
command sources (`/tmp/ytimesy-secrets/agent.env`: `export NAME='value'`
lines and `YTIMESY_REDACTED_SECRETS` naming the runtime ones), and never go
to the box, nor a hash of them. For a turn with runtime secrets the grant
first probes the VM (the env file is readable and names runtime secrets,
python3 runs the filter); if not, no grant and the edge serves the tools as
before. With a grant (`redactOnVm` in `box-tools.json`), the box wraps every
command it runs on the VM (`identity-machines.ts`): stdout and stderr go to
a private temporary directory there, and a Python port of `secretForms`
(same forms: as written, JSON-escaped, URL-encoded, hex, base64/base64url
and the three base64 alignments, longest first, `[REDACTED]`) replaces them
before anything is sent; each form is also matched JSON-escaped, because
the tool helpers print JSON the edge decodes before redacting. The box
learns only how many were replaced. A missing count (filter missing, cut off
by a provider time limit) fails the call with no output. An edit reads the
whole file and writes it back, which would put `[REDACTED]` on disk: a call
whose output was redacted is refused its first write and handed to the edge
(only reads ran), which edits the real text. Differences from the edge:
the box redacts before its own truncation (search results, pages), so a cut
can fall a few characters elsewhere; a command the provider kills at its
time limit shows no partial output.

**The grant, per run** (`claude-box-tool-grant.ts`, `box-tool-identity.ts`).
At each launch the edge deletes the turn's previous identity, starts the VM
(identity requests are not background requests), reads its default Linux user
(`id -un`), creates a Freestyle identity, records its id in
`api_turn.box_tool_identity` (only while this lease owns the running turn),
grants it that one VM as that one user, and mints a token. Any failure leaves
the run on the edge's tools. The token goes only into the run's 0600
`box-tools.json`, is added to the turn's redaction list, and is never logged.
`runner.mjs` imports the bundle, which reads and deletes that file at once;
from then on the token lives only in that process. The edge's step cleanup
also deletes the file.

**Revocation.** Tokens never expire; deleting the identity revokes them. It is
deleted at turn end (both finalize paths), lease loss (renewal refused), Stop
and failover (`stopClaudeCodeRun`), VM replacement (`replacedFrom`, the box's
calls then go to the edge, which has the new VM), and before every new run.
The id is cleared only after a successful delete, so a failed delete is
retried by the sweep: the per-minute `supervise` job deletes identities of
turns that are settled or whose lease lapsed 3 minutes ago
(`staleTurnBoxToolIdentities`).

**Security properties.**

- The box holds no production secret: no Freestyle API key, database URL,
  vault key or account key. It holds per-run grants only (as before, the
  Claude grant), now including one Freestyle identity token.
- That token reaches only that VM's exec and terminal routes, as one Linux
  user. That user has `sudo` on the VM, so it is equivalent to what the run
  could already do through `bash` there: the blast radius is the chat's own
  VM, which already runs untrusted repository code. It cannot start, delete,
  snapshot, route or resize the VM, or reach any other VM or account API.
- The local server listens on 127.0.0.1 behind a 256-bit random bearer that
  exists only in the runner process and the Claude Code it starts. Other runs
  on the same box run as the same Unix user and could read a run's files
  before the runner deletes them, or its process memory; this is the same
  exposure the per-turn Claude grant already has there.
- The identity token can run any command on the VM, so a compromised box
  could read the env file directly: VM-side redaction keeps the values out
  of the box's normal flow, not out of reach of a hostile one. Before it,
  a turn with runtime secrets got no token at all.
- Results are redacted on the box of the turn's VM tokens (machine git,
  ~/memory) known at launch. A token placed on the VM after the run started
  (the memory clone finishing late) is not in that list in phase 2a.

**What the user sees.** Box calls are shown from the run's stream
(`claude-code-stream.ts`, `boxTools`): the call with its input, and the result
as the text the model got (the edge's bridge records the tool's structured
output instead). A call the box handed to the edge after a refusal is shown
twice (stream and bridge); rare.

**File upload crash boundary (2026-11-16, local verification only).** The identity
adapter no longer truncates a destination before sending its chunks. It stages
bytes privately beside the resolved destination, flushes them, preserves existing
permission bits, and atomically replaces the destination only after the complete
upload. Existing symlinks keep pointing to their original targets. Files up to
768 KiB still take one exec; larger files use chunked staging, with cleanup on
handled failures. A process or VM crash can leave an uncommitted staging directory,
but not a partially replaced destination. This is not durable tool-call journaling
or proof that a call with an unknown response may be replayed. Local-shell tests
cover a failed second chunk retaining the original, Unicode split across chunks,
empty files, executable modes and symlinks; live provider failure injection is not
claimed.

**Phase 2b (not built):** mirror the box's calls into the turn's journal
(today the box's run-once is in memory: a restarted runner process starts
over, and Postgres has no record of box calls); an edge Worker route that runs
the rare edge tools without waking the object, or batches them; failover of a
running turn to another box or back to the edge; collecting agent captures and
background exit callbacks without the edge; redacting tokens added after
launch (or the model proxy redacting tool results); measuring call latency
and the object's awake time on a real box. Nothing here was run against a live
box or VM: the tests use fakes and a local shell standing in for the VM.

## Y² on a runner box, with no VM (2026-11-17, not run against a real box)

Y² (the project's super agent) has no machine, so the Claude Code route used to be refused for it. With a runner box it works without one:

- **Who.** Only users `claudeRunnerFor` selects (`YTIMESY_CLAUDE_RUNNER_URLS`, `_SIGNING_KEY`/`_SECRET`, `_USERS` containing the user id or `*`, and `_SESSIONS` if set must contain the Y² chat id). `claudeCodeYSquaredAvailable` (`src/server/adapters/y-mode.ts`) is the single decision for the picker flag, the send gates and failover. Without a runner: refused up front, nothing queued.
- **Turn.** `runClaudeCodeTurnStep` takes `workspace`/`machines` as optional when `runner` and `ySquared` are set: `vm` is null, `shell`/`writeFile`/`readFile` are the box's, no reader preparation, no box tool grants, no VM-replaced check. No runner is `ClaudeRunnerRequired`. `api-turn.ts` passes `ySquared: { instructions: ySquaredInstructions() }`, no workspace, `workspaceTools: []`, no box tools, no thinking pause, and `answerOnly()` stays true (no commit/publish).
- **Working directory and transcript.** `/var/lib/ytimesy-runner/work/<sessionId>` (`claudeRunnerSessionWorkdir`; created with `mkdir -p` before each launch), because Claude keys its session file by the working directory (`claudeCodeProjectDirectory(cwd)`). Saving and resuming use the same stores as any runner-box run (DB record + R2 upload, the `direct` store for large files; both run their commands on the box, so no VM is involved). Stop uses the box (`stopClaudeCodeTurnRun` with a null VM).
- **Prompt and tools.** The system prompt is Y²'s instructions plus one line naming the six `mcp__ytimesy__*` tools: none of the repository, `run_code`, browser, job, canvas, `agent` or `request_project_secret` lines. `options.json` carries `builtInTools: []` (the runner script sets the SDK's `tools: []`, switching every native tool off) and `disallowedTools` = the shared list plus WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, ToolSearch, plan-mode and similar. Only the MCP tools remain, and over the bridge those run at the edge (`ySquaredTools` need no machine).
- **Failure.** A runner transport failure in a Y² turn becomes `YSquaredClaudeRunnerUnreachable` ("The Claude runner is unreachable right now; try again or pick another model for Y².", failover reason `outage`).

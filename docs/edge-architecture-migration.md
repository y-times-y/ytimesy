# Edge architecture migration

Development status, 2026-10-08. This is a staged migration, not a completed Node retirement.

## Cloudflare execution model (decision, 2026-10-12)

Read this before adding a Workflow, moving work into an alarm or cron, or changing
how a chat turn runs.

| Runs on | What | Notes |
| --- | --- | --- |
| DO `ModelConversation` (one per chat) | Runs the chat's turns itself: one model step per alarm, SQLite step receipts, the live stream and turn coordination | No Workflow. Admission calls `startTurn`; each step's alarm sets the next one |
| DO `BackgroundJobRunner` (one per job ID) | On-demand short jobs: turn admission, peer messages, competitions, checkpoints, environment admission | Idempotent by job ID; retries only a pending peer message every 15 s; a failed or interrupted run fails closed |
| Cron (every minute, in the Worker) | Periodic short jobs: admission, reconcile, supervise, delivery, checkpoints, task events, PR repair, work plans; infrastructure every 5 min, environment refresh hourly | Run directly in the scheduled handler; the next tick retries |
| Workflow `ProjectEnvironmentWorkflow` | Clone, install, verify, snapshot a project environment | Install/verify commands wait on the VM for up to 65 minutes. Being moved to a per-project DO with detached commands |

**The 15-minute rule.** A DO alarm and a cron invocation each stop after 15
minutes of wall time; a Workflow step has no limit. A chat step fits: it is one
model call plus tool calls that each return within about a minute, because agent
commands already run detached in tmux on the VM (`start_command` / `wait_command`).
Each step gets a 14-minute budget (`STEP_BUDGET_MS`); the turn keeps its 30-minute
deadline across steps.

**Restarts resume, they do not fail the turn.** Deploys, runtime updates and
evictions restart Durable Objects; in-flight work is stopped when it next touches
DO storage, but its network calls (Postgres, providers, VM) can keep running for a
while. On restart Cloudflare re-fires the alarm, the step's receipt is still
`processing`, and the chat resumes it:

1. It rotates the turn's lease in Postgres, so the old attempt's writes are
   rejected and it stops (no two attempts ever write the same turn).
2. It re-takes the chat's coordination lease (`ConversationRoom.reclaim`).
3. It re-runs the model call with a notice listing the tool calls that had already
   started (`prepareInterruptedStep`); unfinished ones are marked interrupted and
   never replayed automatically. Commands keep running on the VM.

Three consecutive unfinished attempts of one step abandon the turn; lease expiry
(3 minutes for chat turns) then marks it failed for the user. External callers of
`/model-step` can never resume a step; only the owning chat can.

Proof: `EDGE_LIVE_PROOF=1 EDGE_RESTART_PROOF=1 scripts/verify-edge-live-turn.ts`
(needs the `EDGE_RECOVERY_PROOF_BUILD=1` deploy) force-resets a chat mid-inference
and checks that the step resumes under a rotated lease and the turn completes. Add
`EDGE_DEPLOY_PROOF=1` to use a real deploy instead; a deploy may not reach the chat
inside the step window, which the proof reports.

`BackgroundJobWorkflow` and `EdgeModelTurnWorkflow` were removed on 2026-10-12. The
first ran 8+ instances a minute for jobs that take seconds; the second only waited
on the chat DO, and it could not survive a chat restart mid-step anyway.

### Latest cutover gate

#### Node worker retired from application execution, 2026-10-09

`pnpm dev` always executes on the development edge (DO turns, environment and
background Workflows, Git proxy); there is no Node job host. The edge deploy now
enables model, environment, background and cron execution, and PR-repair webhooks
are staged by the edge rather than the Node executor VM. The Node model-step HTTP
executor, its PostgreSQL step receipts, the `model-workflows` Worker and the
job-worker VM deploy were removed. `src/server/jobs/worker.ts` survives only as the
isolated local runner for harness evaluation and refuses to start when edge
execution is configured. Live proof after deploy (version `7b99a46d`): an
OpenRouter `openai/gpt-6-luna` turn completed in 20.3 s with a verified VM file
read, usage/context and stream reconnect; cron background jobs completed. The saved
Codex subscription returned HTTP 401 (expired) and must be reconnected before the
subscription path can be re-proven.

#### End-to-end verification refresh, 2026-10-08

Live development proofs now establish:

- Codex subscription inference in the chat DO, actual reads from a disposable task VM, positive token usage, and persisted SSE reconnect. Active cancellation was fenced; the observed settlement was 196 ms.
- A forced DO restart during real inference preserved its uncertain processing receipt. Replaying that model step returned 409. The deployed Background Workflow recovered the expired turn without replaying uncertain work; a fresh subsequent turn completed and read a new random marker.
- Environment clone, exact selected branch, dependency installation marker, verification, private snapshot activation, and setup-VM pause. Isolated Git push and fetch readback also passed.
- OpenRouter/OpenAI `gpt-6-luna` completed the same read-only model/tool proof in 20,330 ms, with 9,317 input and 156 output tokens. Positive usage/context and SSE reconnect were verified. This is a transport proof, not a coding-speed benchmark.
- The local app was temporarily configured for edge dispatch. A real browser composer submission showed Thinking, completed through a `durable-object` turn, recorded usage/context, and restored its answer after reload. This used the existing loopback QA identity, not a new hosted OAuth login test.

The API proof exposed two native edge transport boundaries: Node socket transport is not appropriate there, and Cloudflare rejects `redirect: "error"` even during Request construction. Request-local native fetch now normalizes that mode before construction, uses manual redirects, and rejects redirect responses without forwarding credentials. Fixed official provider origins/API paths are enforced. Arbitrary custom endpoints remain unsupported in the edge executor rather than losing the Node adapter's DNS/address protections.

The initial OpenRouter Google `gemini-3.8-flash` and Anthropic `claude-fable-5.1` proofs returned HTTP 400. Google's captured rejection was "Requests ending with a model turn are not supported." Runtime status observations had been appended as assistant messages, inadvertently requesting assistant prefill. New observations now use input messages; legacy assistant-ending history receives an append-only continuation boundary. Existing signed/encrypted provider history is not rewritten. Regression assertions reproduced the old failure before the fix. Provider-prefill errors now report a conversation-format problem rather than suggesting invalid keys or missing credit. Direct provider keys were not available for separate live tests.

The corrected Google route passed the full deployed model/tool proof in 27,312 ms; the corrected Anthropic route passed in 30,376 ms. Both independently verified the VM file read, final marker, positive usage/context, and reconnect SSE. These are bounded compatibility proofs, not coding-performance benchmarks. Both disposable VMs and isolated sessions were deleted and the execution gate restored. The corrected normal development Worker is version `2fd974fb-b33a-478f-ab57-f5356f01eea0`; temporary provider diagnostic endpoints are absent.

The full local suite recorded 1,793 passes and six skips; typecheck and production build passed. Additional targeted tests cover native redirect normalization/rejection and bounded preparation errors. Disposable proof VMs were deleted. Execution gates and local dispatch were restored after the browser test; no permanent Node retirement or production cutover was performed.

After the assistant-prefill fix, the full suite recorded 1,797 passes and six skips (337 passing files, one skipped file). Full project/workflow/edge typecheck, production build, selected Biome checks, and `git diff --check` passed. The regression coverage also verifies that the continuation boundary preserves opaque provider history and that surfaced prefill errors do not expose credentials.

Further live provider coverage used the same deployed DO/Workflow proof, saved OpenRouter connection, random VM-file marker, and no fallback. Grok `4.7` (21,174 ms), Z.ai `glm-5.3-flash` (23,977 ms), DeepSeek `v4.1-flash` (22,925 ms), Moonshot `kimi-k3` (15,505 ms), and Mistral `large-4-0` (21,269 ms) passed real tool execution, final marker, positive usage/context, and persisted stream reconnect. Meta `muse-spark-1.3` returned HTTP 403 before inference; it remains unverified with this connection, not a passing result. Every disposable test VM and isolated session was deleted and the execution gate restored. These results cover the named models through OpenRouter, not every model variant or direct-provider credential path.

The following paragraphs retain earlier verification history; this refresh supersedes their statements that active cancellation/restart and live environment activation were untested.

Live isolated Git proxy push and fetch readback passed. A subscription turn also
passed active cancellation fencing (212 ms observed settlement), followed by a
completed fresh turn and persisted streaming reconnect. That test exposed a
misclassified cancellation warning; the typed cancellation fix passes regression
tests, but the corrected warning has not yet been rechecked live.

The earlier environment run exhausted the Free plan's outbound request budget.
Cloudflare rejected a higher configured limit with API error 100328; that
configuration was removed and billing was not changed. The subsequent repair
reduces request amplification instead: potentially long setup commands use the
existing PTY completion stream, short structured inspections keep the one-call
executor, and infrastructure requests have a 30-second inline window before the
SDK's recoverable background polling begins. SDK mutations are not retried or
reimplemented. Each stage logs only request counts, not URLs or credentials.

The corrected live fixture passed exact selected-branch and installation-marker
checks, verification, private snapshot activation, and setup-VM pause on the
existing Free plan. It recorded 24 Freestyle SDK HTTP calls and zero background
polls. These counts exclude WebSocket upgrades and GitHub/other provider calls;
the entire Workflow nevertheless completed within the platform limit. An earlier
proof inadvertently selected the default branch because its fixture used the
product's generated-branch prefix; it is not evidence for the isolated fixture.
The proof now uses a separate `codex/` branch and independently reads prepared
metadata and the installation marker before cleanup.

This bounded success does not guarantee arbitrarily large multi-repository
builds fit Free-plan limits. Application cutover remains disabled; forced restart
during live inference and broader live provider coverage are still pending.
Latest local verification: full application/Workflow/edge typecheck and production
build passed; 28 targeted regressions passed. The full suite passed 1,785 tests
with six skipped (the subsequently added Git timeout regression also passed).

## Ownership

- A shared Worker streams Git smart HTTP to a fixed GitHub origin. Expiring signed grants are owner/project/repository scoped; reusable GitHub tokens remain server-side. Current user access is rechecked on each operation, and writes additionally require the user's push permission. Redirects, arbitrary upstream URLs, and read-to-write escalation are rejected.
- `ModelConversation` owns SQLite model-step receipts and the same chat's persisted streaming snapshot and live turn coordinator. Model execution, progress publication, cancellation and renewal address one owner-scoped DO identity. Persist before inference; an unknown outcome fences replay. Completed receipts, predecessor ordering, and the original deadline survive restart. Legacy PG-receipted turns are rejected by the DO path.
- Development migration `20261008120000_api_turn_executor.sql` records Node versus DO assignment at admission. Admitted and terminal turns cannot switch executor. Legacy step claims and DO routing reject assignments to the other executor; existing turns default to Node.
- `ModelConversation` drives its own turns on alarms (see the execution model above). Step receipts persist references/outcomes, not conversation content; an interrupted step is resumed only by the owning chat, under a rotated lease, with its started tool calls reported to the model instead of replayed.
- `ProjectEnvironmentWorkflow` runs the existing environment recipe directly in Cloudflare steps: resolve sources, claim, provision, checkout/install, verify, activate snapshot, finish/pause. Repository scripts still run in Freestyle. Credentials and secret values do not enter Workflow parameters or returned step values.
- Background jobs (task-event, peer-message, competition, checkpoint, PR-repair, work-plan and maintenance handlers) run without a Workflow: cron runs the periodic ones directly, and on-demand jobs run in a per-job `BackgroundJobRunner` DO. An explicitly pending peer message is retried by alarm every 15 seconds; unknown failures and interrupted runs are not retried. Signed admissions preserve job identities across uncertain HTTP acknowledgement, and re-admitting a job reports its state.
- PostgreSQL still owns users, projects, authorization, queryable conversation history, task records, accounting, and project memory. It currently also owns admission, heartbeat/cancellation, checkpoints, and queued job delivery. Those hot execution responsibilities have **not** been cut over to DO storage yet.
- Freestyle still supplies each task's Linux execution environment, filesystem, tools, and desktop. This change does not resize or delete existing machines.

## Deployed development resources

- Worker: `ytimesy-edge-executor-development`
- DO namespaces: `MODEL_CONVERSATIONS` (SQLite migration `v1`), `BACKGROUND_JOBS` (`BackgroundJobRunner`, migration `v2`)
- Workflow: `ytimesy-project-environments-development`
- Hyperdrive: `ytimesy-development-postgres`; query caching disabled, origin connection cap 5, `verify-full` with the existing Supabase CA

The Git proxy is enabled for signed requests. Model, environment, background execution and the minute recovery schedule remain independently gated and disabled outside bounded proofs. The application URLs remain opt-in; the running app has not been switched away from its existing executor.

Hyperdrive is necessary here: a minimal local workerd probe reproduced direct `pg` connections terminating unexpectedly. Its origin connection was verified during creation. Octokit's edge Web Crypto signing path also required converting the existing PKCS#1 key to PKCS#8 during deployment; key identity is unchanged.

## Verified versus pending

Verified:

- A real development Background Workflow completed; repeated signed admission reused its identity. No provider inference or VM was used for that routing proof.
- Local workerd fixture: signed snapshots, chat streaming, cancellation/renewal fencing, released-turn replay rejection and owner isolation share the model DO namespace without PostgreSQL access.
- Development retirement preflight found no active API turns or queued/active/deferred jobs in the eight known legacy queues. Empty backlog is necessary, not sufficient, for retirement.
- Invocation-scoped telemetry and delivery tasks are awaited before the request-owned database closes; concurrent invocations cannot reuse each other's sockets.

The initial direct subscription proof failed: its catalog request returned HTTP 403 before inference or tool execution. The same account's catalog succeeded locally. A longer request timeout did not fix it; the original seven-second bound was restored. The separate paired egress probe and relay proof below establish the current result. Permanent application cutover remains disabled.

One attempt also exposed ingress-versus-DO deployment propagation: Workflow admission succeeded but its first chat step failed, leaving a stale API-turn heartbeat. The operator proof now checks a terminal synthetic turn against the actual chat DO before admitting inference. Its final readiness check passed; the catalog still returned 403. Recovery cron remains disabled during proofs, so this check does not claim live stale-turn recovery.

Disposable proof VMs and chats were removed and the model gate disabled after each attempt. Application dispatch settings remain unchanged. Do not retire the old executor on the strength of routing fixtures. The initial live proof was blocked by subscription catalog access; the subscription egress repair below is a separate verification stage. No billing/provider fallback was used.

### Subscription egress repair

An isolated probe sent identical fixed catalog and tiny inference requests with
the same connected account locally and from a disposable Cloudflare Worker.
Both endpoints returned HTTP 200 locally; both returned HTTP 403 HTML from
Cloudflare (9 ms catalog, 4 ms inference). This establishes a runtime/egress
difference, not the provider's undisclosed policy or a specific WAF rule. The
probe Worker and its temporary secrets were deleted.

`/api/internal/codex-transport` provides an explicitly configured subscription-only
relay on the trusted Node web backend. Expiring body-signed requests carry an
owner reference, fixed operation and optional account fence; they never carry
OAuth credentials. The backend reads and refreshes that owner's encrypted
credentials under the existing row lock. Only catalog, usage, Responses and
Responses compaction paths are allowed. Success bodies stream unchanged,
including opaque reasoning; errors and response headers are filtered. Redirects
are never followed, inference is not retried by the relay, and the caller's
cancellation signal passes through. No new inference deadline is imposed.

The model loop, tool decisions and chat progress still run in `ModelConversation`.
No native Codex process or authenticated project VM is introduced. Other API
providers are unchanged. `YTIMESY_CODEX_RELAY_URL` and
`YTIMESY_CODEX_RELAY_SECRET` are paired, explicit server configuration; an invalid
or unavailable relay fails closed rather than selecting a different provider.

Live deployed inference, a completed VM file-read returning a private random
marker, final answer, token accounting and persisted DO reconnect streaming
passed with the strict semantic verifier (18.386 seconds for one tiny turn,
not a performance benchmark).
The proof counts `dynamicToolCall` activity and requests a valid positive stream
revision. Its SSE verifier now uses the maintained `eventsource-parser` and
requires a completed assistant answer, matching completed tool output and token
usage; a marker appearing only in the user prompt cannot satisfy it.
Cancellation and restart during real inference remain unverified. The relay handler was hosted through a temporary laptop tunnel for
this earlier proof, **not** permanent production hosting. Temporary relay configuration,
test machines and chats were removed. The following VPC proof supersedes the
Node-hosting prerequisite for subscription transport.

### Cloudflare-native subscription egress

The account-wide `cf1:network` VPC/Gateway binding passed a disposable live probe:
catalog HTTP 200 in 506 ms and completed subscription inference HTTP 200 in
1,190 ms. No Node relay, customer tunnel or new persistent VM was used. The first
probe returned HTTP 500 because it tried to use `Function.bind` on the binding's
remote method; invoking `EGRESS.fetch(input, options)` through a closure passed.
Both disposable probe Workers were deleted.

The development executor now binds `CODEX_EGRESS`. Invocation-local async scope
routes subscription requests through that binding, preserving owner-bound token
refresh, account fencing, cancellation, streaming and cache-affinity headers.
It does not replace global fetch or change other providers, and failures do not
retry through another transport. Missing binding access fails rather than
silently using the relay. Device-code sign-in is unchanged. The optional explicit
Node relay remains available outside this DO path; it is no longer required here.

The production adapter running in the deployed DO completed a second live proof
in 18,090 ms with `gpt-6-luna`: four tool cards, independently verified private VM
file-read output and final answer, saved token usage, and semantically verified
reconnect SSE. This tiny turn is not a performance benchmark. The disposable VM
and chats are cleaned up by the proof; model execution is returned to disabled.
Application dispatch remains unchanged pending the wider migration gates.

Verification: 29 targeted tests, production build, edge TypeScript check, selected
Biome checks and `git diff --check` passed. Full-project TypeScript remains blocked
by the existing unrelated `scripts/prove-codex-subscription-harness.ts:88` error
(`error` is not a property of `{}`); this change does not claim a clean full check.

Cloudflare documents public Gateway egress, and a public reproduction attributes
ordinary Worker rejection to the injected `CF-Worker` provenance. Our own VPC
success confirms the working transport, not OpenAI's undisclosed filtering rule.
See [research and sources](research/codex-cloudflare-egress-2026-10-08.md).

- Runtime fixture: SQLite uncertain/completed receipts persist across workerd restart and are isolated by chat.
- Request-scoped resources share clients only within one invocation and close before their database pool; TLS verification remains enabled.
- Local proxy contract: authentication, repository/method/service restrictions, revoked-access rejection, streaming, header isolation, redirect rejection.
- Live development: unsigned Git request returns 401; signed GitHub upload-pack advertisement returns 200 and streams successfully through Hyperdrive authorization and server-side App signing.
- Live read-only fetch and checkout through the guest transfer adapter also passed against the repository's current default branch. The first attempt correctly failed because the saved task branch had been deleted; no saved branch selection was changed. Temporary checkouts and grant files were removed.
- Live deployed DO terminal-result routing and repeated requests passed; Node-assigned turns returned 409. A binding-based model Workflow completed with a synthetic terminal turn, and duplicate admission reused its identity. Temporary Workflow/turn records were deleted and the execution gate restored to disabled. This does **not** prove inference, tools, or active-turn recovery.
- Environment dispatch now carries the queue job ID into Workflow admission. Both HTTP retries and retries of the same queue job reuse that ID; a new user request still gets a new identity. Regression tests cover lost-response retries and invalid IDs.

Not yet verified or completed:

- Live push, private LFS, and submodule authentication. LFS/dumb HTTP endpoints intentionally fail closed; they are not silently forwarded.
- Live cancellation/restart during inference and broader provider/tool coverage. The bounded subscription relay proof is not evidence for every provider.
- Draining legacy turns and validating application dispatch configuration before enabling model cutover. Persisted executor assignment is implemented; subscription egress no longer requires permanent Node relay hosting.
- Moving chat-local active state, steering/delivery acknowledgements, and supervision off their existing PG/realtime coordination paths.
- Moving background admission, outbox consumers, checkpoint/repair/retention sweeps, and refresh scheduling off the Node worker.
- Full environment Workflow recovery/cleanup and live activation. Its non-idempotent stages have automatic retries disabled to avoid uncertain side-effect replay.
- Final application cutover and removal of the superseded Git bundle and Bun/Rigkit fallback.

Do not stop the Node worker based on the deployed bindings or fixture tests alone.

## Commands

```sh
pnpm typecheck:edge-executor
pnpm exec vitest run tests/conversation-step-runtime.test.ts tests/conversation-step-receipts.test.ts tests/github-git-proxy.test.ts tests/database-scope.test.ts
node --env-file=.env --import tsx scripts/deploy-edge-development.ts
node --env-file=.env --import tsx scripts/verify-edge-development.ts
node --env-file=.env --import tsx scripts/verify-edge-git-transfer.ts
node --env-file=.env --import tsx scripts/deploy-turn-executor-development.ts --apply
node --env-file=.env --import tsx scripts/verify-edge-model-routing.ts
# Operator proofs require explicit subscription/compute authorization.
EDGE_SUBSCRIPTION_PROOF=1 node --env-file=.env --import tsx scripts/verify-subscription-egress.ts
EDGE_RELAY_PROOF=1 node --env-file=.env --import tsx scripts/verify-edge-subscription-relay.ts

# Isolated Cloudflare VPC catalog and inference proof; deletes its probe Worker.
EDGE_SUBSCRIPTION_PROOF=1 EDGE_SUBSCRIPTION_VPC_PROOF=1 node --env-file=.env --import tsx scripts/verify-subscription-egress.ts
```

The deployment script is development-only and passes secrets over stdin, not CLI arguments. It reads the original encryption key; it never generates a replacement. Do not commit `.env`, secret files, or runtime-generated Wrangler artifacts.

The model routing proof temporarily enables the development gate, admits only synthetic terminal turns, then disables it in `finally`. It uses no inference or VM. Application cutover requires `YTIMESY_MODEL_EXECUTION_TARGET=durable-object`, enabled Workflow dispatch, and the edge Worker origin as the Workflow URL; none of those local application settings were enabled during this stage.

## Reference

- [Hyperdrive node-postgres connection guidance](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [Hyperdrive TLS verification](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
- [Workflow retry and state rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

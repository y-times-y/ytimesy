# Harbor bridge v2

Runs the **current** ytimesy builder harness inside a Harbor trial (Terminal-Bench
4.0 through Harbor 0.24.0). The frozen v13 bridge (`benchmarks/harbor/`) is
unchanged and remains the harness of record for the TB4 runs; v2 lives in
`evals/harbor_v2/` and only imports from `benchmarks/`.

| | v13 (frozen) | v2 |
|---|---|---|
| Model | OpenAI API, `gpt-6.1-sol` only | OpenAI API, Anthropic direct, Gemini, Codex subscription, OpenAI models in Amazon Bedrock; any model id with a known price |
| Tools | `current` shell surface | `builderToolSurface` for the variant: `lean` (default), `lean-native`, `current`; code mode; hosted web search |
| Prompt | custom one-liner | the product's `agentTurnInstructions` (root builder, lean shape) |
| Repository guidance | tool | conversation messages at turn start (as the product) |
| Review loop | no | `review=on` runs the product's review loop in process |
| Spending | none mid-trial | per-request guard (trial cap + request limit) and a shared total-cap ledger |
| Transport | OpenAI-SSE-only guard, preloaded by hand | provider-neutral guard, always on |
| Trajectory | `ytimesy-trace.json` only | `trajectory.json` (ATIF-v1.7, validated by Harbor's model) + `ytimesy-trace.json` |
| Preflight | by hand | `preflight.ts` (oracle = 1, nop = 0, real grader); the bridge refuses unpreflighted tasks |

## Files

- `evals/harbor_v2/agent.py`: the Harbor agent (`YtimesyHarborV2Agent`). Subclasses the
  frozen agent for setup (guest prerequisites, task skills, `mcp-call`), starts the
  bridge, answers its exec requests with `environment.exec`, records tokens and cost in
  Harbor's `AgentContext`, and fails the trial (exception, not a 0) when the bridge
  refuses or cannot start. Reads the task's agent timeout from the trial's
  `config.json` and the cached `task.toml` (Harbor does not pass it to agents).
- `bridge.ts`: process entry; config, preflight gate, key check, transport guard, the
  Codex loopback database when needed, then `runHarborTrial`.
- `trial.ts`: one trial: ledger reservation, harness, model run, review loop, trace,
  ATIF, settlement. Takes the container, runtime and storage as inputs, so it runs
  offline in tests.
- `harness.ts`: the product's turn setup without the database (see "What differs").
- `runtime.ts`: the route's runtime. API routes use `apiModelRuntime`
  (`src/server/services/api-agent-runtime.ts`), the same builder a stored connection
  uses; the subscription uses `codexSubscriptionModel`.
- `bedrock.ts`: the `bedrock` route's endpoint, inference-profile ids, AWS credentials and
  SigV4 request signing; `bedrock-smoke.ts`: a two-request paid smoke (run only when approved).
- `config.ts`, `spend.ts`, `transport-guard.ts`, `atif.ts`, `review.ts`, `preflight.ts`,
  `harbor-machines.ts` (wire protocol, same format as v13).

## Configuration (environment of the `harbor run` process)

| Variable | Meaning |
|---|---|
| `YTIMESY_HARBOR_ROUTE` | `openai-api`, `anthropic`, `gemini`, `codex-subscription` or `bedrock` (required) |
| `YTIMESY_HARBOR_APPROVED` | must equal the route: the operator's billing approval (required) |
| `YTIMESY_HARBOR_MODEL` | default `gpt-6.1-sol` / `claude-opus-5-5` / `gemini-3.8-flash` / `openai.gpt-6.1-sol` (bedrock) |
| `YTIMESY_HARBOR_EFFORT` | `low` … `max` (default `max`) |
| `YTIMESY_HARBOR_VARIANT` | harness variant flags, e.g. `lead=fusion,review=on,checkerMode=pair,rigor=on,codeMode=primary`. Supported: `toolSurface`, `codeMode` (`on`, `primary`), `review`, `checkerMode` (`single`, `pair`; pair needs `review=on`), `lead` (`fusion`), `leadTools` (`thin`, `full`), `leadEffort` (`high`, `inherit`, `low`, `medium`, `xhigh`, `max`), `rigor`, `promptCacheScope`, `grind`, `effortMix`, `envSnapshot`, `ledger`, `goal` (all `on`/`off`, default off; results in `docs/research/harness-switches-2026-10-25.md`), `plan` (`on`: the root builder gets `update_plan`, Codex's step list with pending/in_progress/completed; each update is in the trace's `plan` and the trajectory's extra metrics), `helpers` (`on`: the root builder gets `agent` (role researcher or reviewer, title, brief, wait), `agent_wait` (collect one or all reports) and `agent_send` (stop, or brief a finished helper again); each helper is a read-only reader on its own copy of the checkout, on the builder's model and effort, with web search and its own 60-step/15-minute/1.5M-token budget, counted in the trial's usage, spend cap and ATIF subagent trajectories; at most 4 run at once; the builder stays the only writer; `write`: as `on`, plus role `writer` with a required `owns` list: it runs in the builder's own checkout (no copy, no worktree) with the full tool surface but no agent tools, may change only the paths in `owns` (stated in its role prompt, not enforced; write/edit calls outside them are logged as `wrote outside owns`), has a 150-step/45-minute/4M-token budget, and counts like a helper (role `writer` in the trace, usage and ATIF); the builder's section says to decide on writers once, after the first look at the task and files, only when the work splits into two or more parts that can be built and checked separately and each is a large job on its own, each writer with its own files, and never later in the run; the task's time limit is not a criterion, since every TB4 task states the same 8 hours), `fetch` (`on`: every agent gets `web_fetch`, one public http(s) page as text: HTML via html-to-text without scripts, styles or images, text/JSON/XML as is, final URL and status, cut at the lean read limit with an `offset` to read on; fetched on the harness side on any route with a 30 s timeout and a 5 MB download cap; no cookies or credentials sent; private, loopback, link-local and metadata hosts refused, on every redirect hop; non-2xx, non-text and oversize pages are errors), `search` (`function`: agents get a plain `web_search` function tool, also callable from run_code, instead of the provider-hosted search tool; each call is its own low-effort request with only the hosted tool, recorded as a `search` child session so its tokens, queries and Bedrock search fees count in the trial; default `hosted`: the hosted tool in every request, which adds ~2.9K hidden input tokens to each request on Bedrock Astra), `prompt` (`minimal`: the root builder gets identity, tool and run_code guidance, helpers and a brief final answer only; a test variant, default `full`), `roleModels.{writer,writerEscalation,classifier,checker,checkerWorker}`. Refused: `subagents=on`/`force` (several writers at once: product-only, they need the database and a VM fork per writer; use `helpers=on` for read-only subagents), `attempts`, memory, `prEvidence`, `roleModels.{researcher,reviewer,judge}`. |
| `YTIMESY_HARBOR_TRIAL_USD_CAP` | per-trial cap; default $20 or the total cap if lower; at most $100 |
| `YTIMESY_HARBOR_TOTAL_USD_CAP` + `YTIMESY_HARBOR_SPEND_LEDGER` | total cap and its JSON-lines ledger; required on paid routes |
| `YTIMESY_HARBOR_REQUEST_LIMIT` | model requests per trial, builder and checkers together (default 400) |
| `YTIMESY_HARBOR_WEB_SEARCH` | `off` removes the provider's hosted web search (default on, as in the product; bedrock: off, and `on` is refused) |
| `YTIMESY_HARBOR_BEDROCK_REGION` | bedrock: the Region (default `us-east-1`; web search needs us-east-1, us-east-2 or us-west-2) |
| `YTIMESY_HARBOR_BEDROCK_ENDPOINT` | bedrock: `mantle` (default, with Bedrock Web Search) or `runtime` (bedrock-runtime, no web search) |
| `YTIMESY_HARBOR_BEDROCK_PROFILE` | bedrock on `runtime` only: `global` (default, list price) or `us` (geographic, +10%) inference profile |
| `YTIMESY_HARBOR_AWS_PROFILE` | bedrock: AWS profile in `~/.aws/credentials` (else `AWS_PROFILE`; else `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` when set; else `harbor`) |
| `YTIMESY_HARBOR_PREFLIGHT` | the preflight file (`preflight.ts` output), or `skip` |
| `YTIMESY_HARBOR_KEY_FILE` | key file; default `.secrets/openai-api-key`, `.secrets/anthropic-api-key`, `.secrets/gemini-api-key`. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` win when set. |
| `YTIMESY_EVALUATION_CODEX_AUTH_FILE` | subscription route: local Codex sign-in (`~/.codex/auth.json`), ≥ 2 h of access left |
| `YTIMESY_TRANSPORT_LOG` | JSON-lines transport log (one line per streamed request; cut streams keep their request body beside it) |
| `YTIMESY_HARBOR_AGENT_TIMEOUT_SEC` | overrides the agent timeout read from the task |
| `YTIMESY_HARNESS_COMMIT`, `YTIMESY_HARNESS_VERSION`, `YTIMESY_BRIDGE_BUNDLE` | fingerprint recorded in every trace and trajectory (bundle: its SHA-256) |

API routes run the bridge without `DATABASE_URL` (any accidental database use fails
instead of touching the development database). The subscription route loads `.env`
and then points `DATABASE_URL` at a per-trial loopback Postgres in Docker
(`benchmarks/evaluation/operator-database.ts`, needs the `postgres:13` image and a
repository checkout on the host), holding only the access token.

## Amazon Bedrock (route `bedrock`)

OpenAI models in Amazon Bedrock through the **OpenAI Responses API on bedrock-mantle**
(`https://bedrock-mantle.<region>.api.aws/openai/v1/responses`), the endpoint that runs
Bedrock's hosted **Web Search** (docs.aws.amazon.com/bedrock/latest/userguide/web-search.html).
It is the same request and stream format as api.openai.com, so the product's OpenAI
Responses transport (`apiModelRuntime`, provider `openai`) runs unchanged: function tools,
streaming, reasoning effort, `store: false` with encrypted reasoning carried forward, and
`prompt_cache_key` (keyed to the trial's cache scope). Converse was not used: it would need a
new transport and loses the Responses-shaped reasoning items the loop relies on.
`YTIMESY_HARBOR_BEDROCK_ENDPOINT=runtime` switches to bedrock-runtime
(`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`): global profile at list price,
but no server-side tools, so no web search.

- **Web search** (mantle, on by default): the builder gets OpenAI's `web_search` tool with
  `searchContextSize: medium` and `externalWebAccess: false`, so Search uses Bedrock's web
  index and Fetch its cache and nothing leaves AWS; this is how Codex runs search on Bedrock.
  Sidekicks and checkers get none, as on the other routes. Needs
  `bedrock-websearch:InvokeSearch` and `InvokeFetch` (in `AmazonBedrockFullAccess`).
  $12 per 1,000 queries (AWS price list, `USE1-Bedrock-Websearch-Queries`): the spend guard
  and the trial cost add $0.012 per query (each query of a search, each page open counted as
  one, an overcount when Bedrock bills opens as part of the search).
- **Models**: give foundation ids (`openai.gpt-6.1-sol`, `openai.gpt-6-luna`). Mantle serves
  them in the Region by that id (a `global.` prefix is dropped). On `runtime` the bridge
  requests them through the inference profile `global.openai.<model>` (or `us.` with
  `YTIMESY_HARBOR_BEDROCK_PROFILE=us`); there is no silent fallback.
  The OpenAI client is given the bare id (`gpt-6-luna`) so it treats the model exactly as on
  `openai-api` (reasoning model, developer instructions, catalog context window); the signer
  puts the Bedrock id in the request body before signing.
- **roleModels**: `bedrock:<model>`, `api:<model>` or a bare `<model>` on this route, e.g.
  `lead=fusion,review=on,checkerMode=pair,roleModels.checker=bedrock:openai.gpt-6.1-sol,roleModels.writer=bedrock:openai.gpt-6-luna,roleModels.checkerWorker=bedrock:openai.gpt-6-luna,roleModels.classifier=bedrock:openai.gpt-6-luna@low`.
  `bedrock:` on another route, or `codex:` here, is refused.
- **Auth**: every request is signed with AWS SigV4 (service `bedrock-mantle`, or `bedrock` on
  runtime) from the operator's AWS credentials (see `YTIMESY_HARBOR_AWS_PROFILE`); nothing is
  written to a file or logged. The signer refuses any host but the configured endpoint's.
- **Prices** (`src/domain/model-pricing.ts`): mantle's in-Region foundation id is priced like a
  geographic profile (+10%): AWS prices global below in-Region for these models and publishes
  no exact premium; confirm against the bill. A global profile is billed at OpenAI's list price
  (Sol $2 / $0.10 cached / $2.50 cache write / $10 out, above 272K input $4 / $0.20 / $5 / $15;
  Luna $0.10 / $0.01 / $0.125 / $0.50, above 272K $0.20 / $0.02 / $0.25 / $0.75); a
  geographic profile at +10%. Bedrock bills cache writes: they are priced from
  `input_tokens_details.cache_write_tokens` when the response reports it; if it does not,
  written tokens are priced as uncached input (an undercount of at most $0.50 per million
  written for Sol).
- **Spending**: the same guard and ledger as other paid routes (`YTIMESY_HARBOR_APPROVED=bedrock`,
  per-trial and total caps). Request ids (`x-amzn-requestid`) appear in the transport log; the
  transport guard covers these streams as OpenAI Responses streams.
- **Smoke** (two paid requests, one per model: web search, then a tool call; stream + cache
  stats; about $0.05, measured 2026-10-21):
  `YTIMESY_HARBOR_ROUTE=bedrock YTIMESY_HARBOR_APPROVED=bedrock YTIMESY_HARBOR_TOTAL_USD_CAP=0.05 YTIMESY_HARBOR_TRIAL_USD_CAP=0.05 YTIMESY_HARBOR_SPEND_LEDGER=.ytimesy/harbor-v2/bedrock-smoke.jsonl YTIMESY_HARBOR_EFFORT=low pnpm exec tsx evals/harbor_v2/bedrock-smoke.ts`

## Checker model (roleModels.checker)

`roleModels.checker=<model>[@<effort>]` runs the review checker on its own model, on the
trial's route (one transport and credential per trial): `codex:<slug>` on
`codex-subscription`, `api:<model>` on an API route, a bare `<model>` on whichever route
the trial uses. A stored-connection route id (`api/<id>/<model>`), a model on another
route, or a paid model without a list price is refused. Without an effort the checker
uses the builder's. The checker's runtime is built on its first check; its requests pass
the same guard; its usage is priced at its own model (trial cap, ledger, ATIF subagent
trajectory, the review state's `rounds[].checker.model`).

## lead=fusion, checkerMode=pair, rigor (one writer)

Child sessions live in memory for the trial (`sessions.ts`: role, parent, model, events,
briefs, reports, conversation), in place of the product's agent_sessions rows and mailboxes.
`children.ts` holds the lead's tools and the pair judge's worker tool.

- **lead=fusion**: the builder is the lead, with the product's fusion lead prompt block. Before
  its first model call the harness runs the sidekick's exploration round on the request
  (`harnessExplorationBrief`); the report is added to the lead's first message. The lead's
  `agent` (role writer, once) and `agent_send` (`id`, `message`, `explore`, `stop`) run one
  sidekick round in process and return its report as the tool result: one writer at a time,
  in the lead's own checkout (no fork), and the lead makes no model call while it works. Any
  other role, or a second writer, is refused ("do the work yourself"). The sidekick gets the
  product's sidekick role block (`newSidekickState` in its budget) and keeps its conversation
  across rounds.
- **Thin lead** (`leadTools=thin`, the default with lead=fusion; product and bridge share
  `src/server/services/thin-lead-tools.ts`): the lead decides, the sidekick does. Its tools
  are `agent`, `agent_send`, the surface's read tool and its command tool limited to
  read-only inspections (git status/diff/log/show, ls, head, sed -n, grep, wc, find; no
  redirection, substitution, background jobs or programs), both capped at 8,000 characters;
  no edit/write/apply_patch, stdin, run_code or web search. Its prompt
  (`fusionThinLeadInstructions`) asks for briefs with goal, files, constraints, steps and
  acceptance checks, and for evidence (commands, exit status, key output) instead of
  rerunning checks. A round's report reaches the lead capped at 12,000 characters. A failed
  round (budget used, error, empty or degenerate output) ends with a notice to re-brief or
  restart: `agent_send` `restart: true` starts a fresh sidekick whose first brief is a
  handoff (the failed one's last brief and message, the changed files) plus the lead's
  message, at most `SIDEKICK_MAX_RESTARTS` (2) per trial; `fusion.restarts` in the trace.
  The review checker still runs after the lead's answer; its findings go back to the lead,
  which can only fix them through the sidekick. `leadTools=full` restores the earlier lead
  (whole builder surface, earlier prompt) for comparison.
- **leadEffort** (default `high`): a ceiling on the lead's own reasoning effort
  (`leadReasoningEffort`; `inherit` keeps `YTIMESY_HARBOR_EFFORT`). The sidekick keeps
  `roleModels.writer`'s effort (else `YTIMESY_HARBOR_EFFORT`), the checker its own. The
  trace's `leadEffort` is the effort applied.
- **Classifier**: after every round, the product's `CLASSIFIER_INSTRUCTIONS`, `classifierMessage`,
  `parseClassifierReply`, `applicableDecision` and the rules fallback, one tool-free call on
  `roleModels.classifier` (the builder's model when unset; the product defaults to
  `codex:gpt-6-luna@low`). The decision record (tokens, cost at the classifier's price,
  source, model) is in the trace's `fusion.decisions`; a hand_back/switch_model notice is
  appended to the round's report. Differences: no sidekick signals (`signals: []`) and no
  diff line counts; switch_model moves the sidekick to `roleModels.writerEscalation` at its
  next round (the product switches at its next compaction).
- **Irreversible actions stay with the lead**: the bridge has no push, PR or deploy tools for
  anyone; the sidekick's prompt forbids commit, stash, reset, branch switches and discarding
  others' changes (the product's rule; prompt-level, as in the product). Not enforced by a
  tool guard: a sidekick could still run `git commit` from its shell.
- **checkerMode=pair**: the review checker is the judge (`roleModels.checker`, the product's
  pair brief); its `checker_worker` tool (`brief`, `workers[]`, `id`, `model: strong`) runs
  read-only workers on `roleModels.checkerWorker` (builder's model when unset; product default
  `codex:gpt-6-luna`) with the product's worker brief frame, and waits for their reports.
  The workers' and judge's tool calls are passed to the loop as items, so
  `pairReviewVerdict` marks each test's `ranBy`.
- **rigor=on**: the product's rigor block in the builder's (and sidekick's) prompt, and the
  review loop's rigor checks.
- **Readers never write the checkout**: before each check the checkout (with `.git` and the
  review refs) is copied with `cp -a` to `/tmp/ytimesy-readers/<trial>/<checker>/checkout`;
  the checker and its workers run there (their `cwd`, and the brief's checkout paths are
  rewritten to the copy). Difference from the product: the product runs readers as a reader
  Linux user that cannot write the checkout; here a reader's shell could still write the
  original by an absolute path it was never given. Nothing is restored afterwards. The trace's
  `review.readerCopies` lists each copy.
- **Costs per role**: every child's usage counts in the trial cap at its own model's price;
  `efficiency.modelRows` has `builder`, `sidekick`, `checker`, `checkerWorker` and
  `classifier` rows; each child is an embedded ATIF subagent trajectory
  (`<harness>-<role>`).

## Cost block (AA-style)

Every trial's `ytimesy-trace.json` and `trajectory.json` (`final_metrics.extra.efficiency`)
carry the shared eval-efficiency summary (`src/domain/eval-efficiency.ts`, the block
`scripts/hard-set.ts` prints): `$`/task, tokens (in/out), model calls, cache hit rate,
seconds, and `modelRows` per role (builder, checker) and model, each at its own price
(`~$` = list-price estimate on plan-billed routes). Harbor's `AgentContext` metadata gets
the same block. Per job (arm), joined with the verifier reward:

```sh
node --import tsx evals/harbor_v2/efficiency.ts .ytimesy/harbor-v2/smoke [job ...]
```

## Spending caps

- **Per request** (`spend.ts`): every model request, builder, review checker and native
  compaction, passes `guardedLanguageModel` first. It refuses once the trial's list-price
  estimate (`usageCostUsd` on the cumulative usage of all runs) reaches the trial cap, or
  the request limit is used. The refusal ends the builder; the trace names the cap.
  Overshoot is at most one request's cost.
- **Total** (ledger): before any inference a trial reserves its whole trial cap; it may
  start only if settled spend + open reservations + its cap ≤ the total. At the end it
  settles its estimate. A crashed trial keeps its reservation (overcounts, never under).
  Concurrent trials are serialized by an atomic `mkdir` lock (tested with 8 parallel
  reservations). `touch <ledger>.stop` refuses every new trial. When the committed total first
  reaches 50% and then 80% of the total cap, a `{"type":"warning",...}` line is appended to the
  ledger (once each) and the trial log prints `warning: Spend ledger at 50% ...`;
  `ledgerSummary` returns them.
- A model without a known list price cannot run on a paid route (no price, no cap).
- Not counted: a stream the transport guard resent (the cut attempt was billed but its
  usage never reached the harness; every cut is in the transport log) and hosted web
  search fees (per search, not per token). Set caps with that margin.
- Plan-billed subscription trials record list-price estimates and are uncapped unless
  `YTIMESY_HARBOR_TRIAL_USD_CAP` is set.

## Transport guard

`transport-guard.ts` wraps the process's `fetch` once (every route, including the
subscription transport). For a streamed request it holds the response until the
provider's terminal event (OpenAI Responses `response.completed|incomplete|failed|error`,
Anthropic `message_stop|error`, Gemini a chunk with `finishReason` or an error), then
replays the whole stream unchanged. A stream that closes without one is resent (at most
3 attempts, 2 s × attempt apart); if every attempt is cut, the last partial stream is
returned so the harness fails as it would have. Error statuses and non-streamed requests
pass through. Logged: path, request id, status, timings, terminal event; on a cut the last
event types and 4 KB of stream text. No headers or keys are logged.

## Trajectory (ATIF)

Harbor 0.24.0 validates `agent/trajectory.json` with `harbor.models.trajectories`
(`ATIF-v1.0` … `v1.8`) and derives the trial's per-model usage from it
(`load_model_usage_from_trajectory`). The public Codex TB jobs publish `ATIF-v1.7`
(docs/research/native-codex-request-count-2026-10-08.md); v2 writes v1.7: a system step,
the task as a user step, one agent step per model response (text, reasoning, tool calls,
results as observations, per-response metrics and cost, `llm_call_count: 1`), compaction
as its own agent step, review findings as user steps (`extra.kind: runtime-notice`), and
each review checker as an embedded subagent trajectory. `ytimesy-trace.json` keeps the raw
events, the fingerprint and the review rounds. The bridge refuses to start when
`ytimesy-trace.json` already exists in the logs directory (benchmark-lessons incident 16).

## review=on inside Harbor

The review loop lives in the api-turn job stack: its state, the checker subagent and its
report go through the database (`attempt-loop-deps.ts`). The loop itself
(`createReviewLoop`) only needs its dependency interface, so v2 implements that in
process (`review.ts`) and reuses the product's loop, brief, verdict parsing, eligibility,
deadlines and notice unchanged:

- state in memory (a trial is one process and is never resumed);
- the checker is a second model run on the same container with the product's reader
  surface: read-only file tools, a working command runner, a lean shape without write and
  edit (`builderToolSurface` `readOnly`), the read-only lean prompt (`leanReadOnly`), code
  mode as the builder's variant, no agent tool and so no orchestration block; the
  product's checker role prompt and budget (60 steps, 10 min, 800K tokens), the 90 %
  wrap-up notice, no web search, its usage counted in the same trial cap at its own model's
  price (roleModels.checker);
- deadline: Harbor's agent timeout minus 3 minutes (60 s in the agent, 120 s in the loop).

Difference from the product: the product's checker runs its commands as a reader Linux user
that cannot write the checkout. In the bridge the checker works in its own `cp -a` copy of the
checkout (see "lead=fusion, checkerMode=pair, rigor"); nothing is restored afterwards.

Building this found a product bug, fixed on this branch: `captureConversationCode`
rejected the review loop's `refs/ytimesy/review/...` refs, so `review=on` could not take its
first checkpoint with the real capture (its unit tests used a fake).

## What differs from the product turn

Not reproduced, because they need the database, the job stack or a person: cross-chat
memory, plan mode, the user's MCP connections (task MCP servers work through `mcp-call`),
plugins, project secrets, repository lifecycle hooks, several writers at once (subagents=on/force), the attempt loop, the
background-command completion gate and durable step resumption. Write-once tool receipts
and turn memos are in memory. `codeMode=primary` lists run_code first and adds the product's
one-command note to the command tool (`primaryCodeModeTools`, shared with api-turn); it has
no deferred tools to hide, since the bridge offers no agent, plan or MCP tools.

## Verified offline (no model calls, no spend)

- `tests/harbor-v2-trial.test.ts`: whole trials against a mock model with every command
  going through the Harbor wire protocol to a local git checkout: lean tools edit the
  checkout; the product prompt is used; ATIF/trace/ledger are written; with
  `HARBOR_PYTHON=<harbor 0.24.0 python>` Harbor's own model validates `trajectory.json` and
  derives usage for `claude-opus-5-5`. The trial cap stops before the next request; a full
  ledger refuses before inference; an existing trace is never overwritten. `review=on`:
  checker findings return to the builder, the fix runs, the second check passes, the
  checker's stray file is undone, builder + checker usage is one trial's. `review=on,codeMode=primary,roleModels.checker=…`: run_code first in
  the builder's tools and prompt; the checker on its own runtime and model, with commands
  but no write/edit, no orchestration block; cost = each run at its own price; the
  efficiency block's per-role rows.
- `tests/harbor-v2-trial.test.ts`, lead=fusion: exploration round, a sidekick build that
  writes the lead's checkout, two classifier decisions recorded with tokens and cost, the
  lead's answer; the lead's and sidekick's product prompt blocks; rows builder/sidekick/classifier,
  each model separate. checkerMode=pair: the judge briefs a worker, the worker's file stays in
  the copy, findings reach the builder, the fix passes, the worker's test is `ranBy: worker`;
  rows builder/checker/checkerWorker. The single-checker test: the checker's stray file never
  reaches the checkout.
- `tests/harbor-v2-trial.test.ts`, rehearsal of the unattended review and child budgets:
  lead=fusion + review=on (sidekick builds, the checker reviews the lead's turn); a turn
  with no checkout changes is still checked; with rigor=on an answer asking the user a
  question is sent back; a build past the product's hour is checked in the trial's time;
  a check without a verdict is retried once (not a round); a sidekick stopped at its round
  budget gets the last-step notice and the lead gets its last message; a step cut at the
  64K output cap is resampled with the smaller-steps note. The thin lead: its one shell
  attempt is refused, it briefs, inspects with `git status`, answers; the sidekick writes
  and runs the deliverable; the checker passes it; the lead's tools are exactly agent,
  agent_send, bash, read. `leadTools=full,leadEffort=inherit` restores the full surface. The Bedrock request time limits
  are in `tests/harbor-v2-bedrock.test.ts`.
- `tests/harbor-v2-trial.test.ts`, helpers=write: the builder starts two writers with
  disjoint `owns` at once; both write in the builder's checkout, a write outside `owns` is
  logged, agent_wait returns both reports; writers have write/edit and no agent tools; the
  trace, usage (3 builder + 4 writer requests) and ATIF show two writer sessions.
  `tests/harbor-v2-helpers.test.ts`: a writer without `owns` is refused, readers stay
  read-only, a writer briefed again keeps its paths.
- `tests/harbor-v2-sessions.test.ts`: the in-memory session store.
- `tests/harbor-v2-units.test.ts`: config validation, guard, ledger (incl. concurrency and
  stop file), transport guard (Anthropic/OpenAI/Gemini terminal events, resend after a
  cut, give-up path, no credentials in logs), ATIF details (retract, freeform input,
  compaction).
- `tests/harbor-v2-preflight.test.ts`: result parsing, oracle/nop verdicts, the gate.
- The Python agent imports under Harbor 0.24.0's interpreter; its timeout lookup returns
  7200 s for `session-window-debug` at a 0.25 multiplier; a refused trial raises in
  `run()` through the real Python ↔ bridge path. The bridge bundles with esbuild and
  starts from the bundle.
- `node --import tsx evals/harbor_v2/preflight.ts --tasks session-window-debug,shadow-relay --dry-run`
  prints the Harbor commands.

## Not verified

- No live run: no real provider stream, no Harbor container, no grader. The command runner
  only ran on macOS in tests (its Linux exit statuses are covered by its own tests).
- Anthropic native compaction, Gemini, the subscription route and hosted web search inside
  a trial; code mode (QuickJS) inside a trial.
- Bedrock: not a v2 route (`bedrockClaudeRuntime` has no native compaction; Bedrock's
  compaction beta is unverified with our request shape).
- Transport guard against real cut streams (only synthetic ones).

## Reason Agent parity setup

Effort always matches the compared run: xhigh against Reason and Codex on GPT-6 Astra (both their public TB4
jobs ran xhigh), max against Codex on GPT-6.1 Sol. A different effort makes the comparison invalid.

`YTIMESY_HARBOR_VARIANT=codeMode=on,plan=on,helpers=write,fetch=on,search=function` (web search on) matches Reason
Agent 1.2's TB4 setup as its public trajectories show it (198 TB4 trials, GPT-6 Astra xhigh):
bash called directly at each step, code mode optional and used mostly for parallel reads (16% of
calls), a plan tool (12 of 66 tasks), subagents (8 of 66 tasks), web search and web fetch. On
shadow-relay (o200k token count) Reason's output was 6.6k-9.4k: 4.7k-6.0k tool code and
1.6k-3.2k thinking. With `codeMode=primary` ours was 11.2k-13.5k, with 6.1k-7.6k code and
4.9k-5.7k thinking: primary puts every step in one run_code program. `primary` stays the base
default (cheaper than `on` on Sol, 3 tasks); `on` is the parity setting for Reason comparisons.

## Minimal smoke test (do not run without approval)

CPU tasks, local Docker, Codex subscription (plan-billed), today's harness variants:
review loop, code mode primary, the checker on `gpt-6-luna`. From this worktree:

```sh
cd /path/to/cloud-bridge2
mkdir -p .ytimesy/harbor-v2

# 1. Preflight: oracle must score 1 and nop 0 through the real grader. No model calls.
#    (Passed 2026-10-19 for session-window-debug, shadow-relay, mvcc-lsm-compaction.)
node --import tsx evals/harbor_v2/preflight.ts \
  --tasks session-window-debug,shadow-relay --env docker \
  --jobs-dir .ytimesy/harbor-v2/preflight

# 2. One agent trial per task, agent time cut to 1/8 (1 h of the 8 h limit).
export PYTHONPATH=$PWD YTIMESY_REPO=$PWD
export YTIMESY_HARBOR_ROUTE=codex-subscription YTIMESY_HARBOR_APPROVED=codex-subscription
export YTIMESY_HARBOR_VARIANT=review=on,codeMode=primary,roleModels.checker=codex:gpt-6-luna
export YTIMESY_EVALUATION_CODEX_AUTH_FILE=$HOME/.codex/auth.json
export YTIMESY_HARBOR_PREFLIGHT=$PWD/.ytimesy/harbor-v2/preflight/preflight.json
export YTIMESY_TRANSPORT_LOG=$PWD/.ytimesy/harbor-v2/transport.log
export YTIMESY_HARNESS_COMMIT=$(git rev-parse --short HEAD)
for task in shadow-relay session-window-debug; do
  uvx --from harbor==0.24.0 harbor run -d terminal-bench/terminal-bench@4.0.0 \
    -i terminal-bench/$task -a evals.harbor_v2.agent:YtimesyHarborV2Agent -e docker \
    -k 1 -n 1 --agent-timeout-multiplier 0.125 \
    --jobs-dir .ytimesy/harbor-v2/smoke --job-name smoke-$task
done

# 3. Check each trial: reward, Harbor's cost, the ATIF validates under Harbor 0.24.0,
#    the trace's fingerprint, review rounds, checker model and cost block.
HP=$(ls -d ~/.cache/uv/archive-v0/*/bin/python | while read p; do
  "$p" -I -c "import importlib.metadata as m,sys; sys.exit(m.version('harbor')!='0.24.0')" 2>/dev/null && echo "$p"; done | head -1)
for t in .ytimesy/harbor-v2/smoke/smoke-*/*__*/; do
  "$HP" -I -c "
import json,sys
from pathlib import Path
from harbor.models.trajectories import Trajectory
from harbor.utils.trajectory_utils import load_model_usage_from_trajectory
t=Path(sys.argv[1]); r=json.loads((t/'result.json').read_text())
tr=json.loads((t/'agent/ytimesy-trace.json').read_text())
Trajectory.model_validate_json((t/'agent/trajectory.json').read_text())
print(t.name, 'reward', (r.get('verifier_result') or {}).get('rewards'), 'exception', r.get('exception_info'))
print('  usage by model', {k: v.model_dump() for k, v in (load_model_usage_from_trajectory(t/'agent/trajectory.json') or {}).items()})
print('  variant', tr['variant'], 'checker', tr['checkerModel'], 'failure', tr['failure'])
print('  review rounds', tr['review']['rounds'], 'checks', tr['review']['readerCopies'])
e=tr['efficiency']; print('  cost/task', e['perTaskUsd'], 'tokens', e['tokensPerTask'], 'calls', e['callsPerTask'], 'cache hit', e['cacheHitRate'])
for m in e['modelRows']: print('   ', m['role'], m['model'], m['requests'], 'calls', m['costUsd'])
" "$t"
done
node --import tsx evals/harbor_v2/efficiency.ts .ytimesy/harbor-v2/smoke
```

Expected:

- `result.json`: `verifier_result.rewards.reward` 0 or 1, `exception_info` null (a refusal
  or setup failure raises instead of scoring 0); `agent_result.cost_usd` = the trace's
  `costUsd` (a list-price estimate on the plan).
- `agent/trajectory.json` validates (ATIF-v1.7); `load_model_usage_from_trajectory` lists
  `gpt-6.1-sol` (and `gpt-6-luna` from the embedded checker trajectories); the builder's
  `agent.tool_definitions[0]` is `run_code`; each `subagent_trajectories[i]` has
  `model_name: gpt-6-luna` and tools without `write`/`edit`; `final_metrics.extra` has
  `cost_basis` and `efficiency`.
- `agent/ytimesy-trace.json`: `variant` = `codeMode=primary,review=on,roleModels.checker=codex:gpt-6-luna`
  (the label orders keys as the variant does), `checkerModel` `{model: gpt-6-luna, effort: max}`,
  `review.rounds` ≥ 0 with `readerCopies[].ok: true`, `review.state.rounds[].checker.model.modelId`
  `gpt-6-luna`; `efficiency.modelRows` = a `builder gpt-6.1-sol` row and, when a check ran,
  a `checker gpt-6-luna` row, each with its own `costUsd`.
- No ledger on the plan route (no caps unless `YTIMESY_HARBOR_TRIAL_USD_CAP` is set). On a
  paid route the ledger shows one `reserve` and one `settle` per trial, settle = `costUsd`.
- `efficiency.ts` prints one headline per job (`solved/tasks · ~$/task · ~$/solved · tok/task
  · calls/task · cache hit · s/task`) and one line per role and model.
- `transport.log`: one line per streamed request, `terminal` set, no resends expected.

A paid route adds the caps, e.g. Gemini:

```sh
export YTIMESY_HARBOR_ROUTE=gemini YTIMESY_HARBOR_APPROVED=gemini
export YTIMESY_HARBOR_TOTAL_USD_CAP=5 YTIMESY_HARBOR_TRIAL_USD_CAP=2
export YTIMESY_HARBOR_SPEND_LEDGER=$PWD/.ytimesy/harbor-v2/ledger.jsonl
```

and `YTIMESY_HARBOR_VARIANT=review=on` exercises the review loop. For a remote host,
bundle the bridge and set `YTIMESY_BRIDGE_BUNDLE`:

```sh
npx esbuild evals/harbor_v2/bridge.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile=.ytimesy/harbor-v2/bridge.mjs \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
```

Follow docs/benchmark-lessons.md before any scored run.

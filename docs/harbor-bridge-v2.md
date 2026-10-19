# Harbor bridge v2

Runs the **current** ytimesy builder harness inside a Harbor trial (Terminal-Bench
4.0 through Harbor 0.24.0). The frozen v13 bridge (`benchmarks/harbor/`) is
unchanged and remains the harness of record for the TB4 runs; v2 lives in
`evals/harbor_v2/` and only imports from `benchmarks/`.

| | v13 (frozen) | v2 |
|---|---|---|
| Model | OpenAI API, `gpt-6.1-sol` only | OpenAI API, Anthropic direct, Gemini, Codex subscription; any model id with a known price |
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
- `config.ts`, `spend.ts`, `transport-guard.ts`, `atif.ts`, `review.ts`, `preflight.ts`,
  `harbor-machines.ts` (wire protocol, same format as v13).

## Configuration (environment of the `harbor run` process)

| Variable | Meaning |
|---|---|
| `YTIMESY_HARBOR_ROUTE` | `openai-api`, `anthropic`, `gemini` or `codex-subscription` (required) |
| `YTIMESY_HARBOR_APPROVED` | must equal the route: the operator's billing approval (required) |
| `YTIMESY_HARBOR_MODEL` | default `gpt-6.1-sol` / `claude-opus-5-5` / `gemini-3.8-flash` |
| `YTIMESY_HARBOR_EFFORT` | `low` … `max` (default `max`) |
| `YTIMESY_HARBOR_VARIANT` | harness variant flags, e.g. `review=on` or `toolSurface=lean-native,codeMode=on`. Supported: `toolSurface`, `codeMode`, `review`, `promptCacheScope`. `attempts`, `subagents`, memory and `prEvidence` need the product's database and are refused. |
| `YTIMESY_HARBOR_TRIAL_USD_CAP` | per-trial cap; default $20 or the total cap if lower; at most $100 |
| `YTIMESY_HARBOR_TOTAL_USD_CAP` + `YTIMESY_HARBOR_SPEND_LEDGER` | total cap and its JSON-lines ledger; required on paid routes |
| `YTIMESY_HARBOR_REQUEST_LIMIT` | model requests per trial, builder and checkers together (default 400) |
| `YTIMESY_HARBOR_WEB_SEARCH` | `off` removes the provider's hosted web search (default on, as in the product) |
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
  reservations). `touch <ledger>.stop` refuses every new trial.
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
- the checker is a second model run on the same container: lean tools, the product's
  checker role prompt and budget (60 steps, 10 min, 800K tokens), the 90 % wrap-up notice,
  no web search, its usage counted in the same trial cap;
- deadline: Harbor's agent timeout minus 3 minutes (60 s in the agent, 120 s in the loop).

Difference from the product: the product's checker runs as a reader Linux user that cannot
write the checkout. A task container has no such user, so after every check the checkout is
restored to the tree the checker was given (`restoreConversationCode`); the trace records
whether each restore succeeded. Ignored files the checker creates are not removed.

Building this found a product bug, fixed on this branch: `captureConversationCode`
rejected the review loop's `refs/ytimesy/review/...` refs, so `review=on` could not take its
first checkpoint with the real capture (its unit tests used a fake).

## What differs from the product turn

Not reproduced, because they need the database, the job stack or a person: cross-chat
memory, plan mode, the user's MCP connections (task MCP servers work through `mcp-call`),
plugins, project secrets, repository lifecycle hooks, subagents, the attempt loop, the
background-command completion gate and durable step resumption. Write-once tool receipts
and turn memos are in memory.

## Verified offline (no model calls, no spend)

- `tests/harbor-v2-trial.test.ts`: whole trials against a mock model with every command
  going through the Harbor wire protocol to a local git checkout: lean tools edit the
  checkout; the product prompt is used; ATIF/trace/ledger are written; with
  `HARBOR_PYTHON=<harbor 0.24.0 python>` Harbor's own model validates `trajectory.json` and
  derives usage for `claude-opus-5-5`. The trial cap stops before the next request; a full
  ledger refuses before inference; an existing trace is never overwritten. `review=on`:
  checker findings return to the builder, the fix runs, the second check passes, the
  checker's stray file is undone, builder + checker usage is one trial's.
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

## Minimal smoke test (do not run without approval)

CPU tasks, local Docker, Codex subscription (plan-billed) first. From this worktree:

```sh
cd /Users/hetpatel/Documents/ChatGPT/cloud-bridge2
mkdir -p .ytimesy/harbor-v2

# 1. Preflight: oracle must score 1 and nop 0 through the real grader. No model calls.
node --import tsx evals/harbor_v2/preflight.ts \
  --tasks session-window-debug,shadow-relay --env docker \
  --jobs-dir .ytimesy/harbor-v2/preflight

# 2. One agent trial per task, agent time cut to 1/8 (1 h of the 8 h limit).
export PYTHONPATH=$PWD YTIMESY_REPO=$PWD
export YTIMESY_HARBOR_ROUTE=codex-subscription YTIMESY_HARBOR_APPROVED=codex-subscription
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

# 3. Check: reward in result.json, ATIF validates, the trace names the fingerprint.
for f in .ytimesy/harbor-v2/smoke/smoke-*/*__*/result.json; do
  python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(sys.argv[1], (r.get('verifier_result') or {}).get('rewards'), (r.get('agent_result') or {}).get('cost_usd'), r.get('exception_info'))" "$f"
done
```

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

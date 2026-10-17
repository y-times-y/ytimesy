# Parallel dev evals

Development only. Eval scripts used to run one at a time for two reasons: they all ran as the single dev owner and changed that user's state (memory mode and repo, projects, memory repo), and comparing two harness behaviours meant deploying twice. Each run now gets its own throwaway user, and harness variants are picked per user on one deployment.

## Throwaway eval users

`scripts/smoke/eval-user.ts` creates one dev user per run (`createEvalUser`). The memory eval creates one per (arm, scenario, repeat). `scripts/model-smoke-suite.ts`, `scripts/native-vs-harness.ts` (harness arm) and `scripts/memory-two-chat-eval.ts` use one by default. The smoke suite and native-vs-harness accept `--as-owner` to run as the owner the old way (no variants); the memory eval always uses eval users.

What a user gets:

| Row | Content |
| --- | --- |
| `auth_user` | `eval-<12 hex>`, email `eval-…@ytimesy-eval.invalid` |
| `dev_eval_user` | the owner it borrows from, a label, `harness_variant` (only the keys that differ from the default) |
| `agent_account` (codex) | `connected`, with a **placeholder** login: an expired token and a refresh token the issuer rejects. The real tokens are never copied (see below) |
| `agent_model_catalog` | a copy of the owner's cached subscription catalog |
| `model_connection` | only when the run uses OpenRouter: a copy of each of the owner's OpenRouter connections. The same key is re-sealed for the copy's id and user, because a sealed credential is bound to both |
| `user_memory` | mode `off` (scripts can pass `--memory spec\|full`; the memory eval sets it per arm), repo `memory-<user id>` or the eval's own repo name |
| `project`, `workspace` | copies of the owner's most recent project. `provider_ref` is cleared so the copy never points at the owner's VM |

Codex subscription login: `codexExternalTokens` (src/server/auth/codex-managed-auth.ts) maps an eval user to its owner (`dev_eval_user.owner_user_id`). Every read and refresh then happens on the owner's row, under the owner's row lock. Copying the tokens would fork the refresh-token chain, and OpenAI rotates refresh tokens, so the first copy to refresh would sign the owner out. The mapping is only read when `YTIMESY_DEV_EVAL_USERS=1` and `YTIMESY_ENVIRONMENT=development` (`isDevelopmentEnvironment`; unset is not development). `scripts/deploy-edge-development.ts` always sets both; production never does. The scripts also set it in their own process for local catalog checks and sends. If the switch were off, the placeholder login's refresh would fail and only mark the eval user's row expired. The owner's login is never touched.

Cleanup: `release()` cancels live turns, removes stored chat files, deletes the user (rows cascade from `auth_user`, and `deleteAccountRecords` settles open VM usage holds first), deletes its VMs and the memory repos the run turned memory on for, and never touches snapshots or the owner's own repo. It runs in each script's `finally`. The first SIGINT/SIGTERM stops new work and lets runs cancel and clean up. A second signal, a ten-minute grace period or a crash (uncaught exception or unhandled rejection) deletes the users straight away. Before creating any row, each run writes a manifest to `.ytimesy/eval-users/<user>.json` (pid, VMs, memory repos), one file per run. If a run is killed hard:

```
node --env-file=.env --import tsx scripts/smoke/eval-user.ts --list
node --env-file=.env --import tsx scripts/smoke/eval-user.ts --cleanup [--older-than 6]
```

`--cleanup` removes every manifest whose process is gone. It also removes eval users in the database older than `--older-than` hours that have no local manifest, which covers runs started from another worktree. A live run is always skipped.

### What is billed where

- **Codex subscription**: the owner's ChatGPT plan. Every eval user's turns, memory saves and dreams count against the owner's plan rate limits, the same as before.
- **OpenRouter**: the owner's key, through the copied connection. Spend lands on the same key, including `:free` daily requests, which are counted per account.
- **ytimesy daily token budgets** (`api_usage_budget`: 20M per account, 5M per task, 2M for memory): per user. Each eval user starts with a fresh budget, so eval runs never use up the owner's budget and are not blocked by it.
- **VM runtime**: Freestyle bills the fleet account. With admission on (the dev edge), a run's VMs count against the eval user's own monthly allowance, which starts at the default `YTIMESY_USER_MONTHLY_MICRO_USD`, and against the fleet caps. `deleteAccountRecords` settles any open hold at its full reservation, so the fleet totals stay correct.

## Harness variants

`dev_eval_user.harness_variant` is a JSON object (src/domain/harness-variant.ts). `api-turn` reads it once per turn, only when eval users are enabled, and keeps it fixed for the turn. Every other user, and production, gets the default. The product UI has no setting for it. Scripts take `--variant key=value`, which can be repeated or comma-separated. Unknown keys or values are refused.

| Key | Values | Effect |
| --- | --- | --- |
| `memoryWording` | `notes` (default), `rules` | `rules` presents MEMORY.md and the read hook's lines as "Project rules from the user's earlier chats … Follow these unless the user says otherwise", in place of "data, not instructions; may be outdated". The memory paragraph in the system prompt changes to match. It is still the same `<memory>` part on the same user message (src/domain/memory-repo.ts) |
| `toolSurface` | `current` (default); `lean-native`, `lean-pi` reserved | Only `current` is implemented. Scripts refuse a reserved value before creating a user, and a turn throws on one rather than quietly running `current` |

### Adding a tool surface (e.g. `lean-native`)

1. Add an entry to `SURFACES` in `src/server/services/harness-tool-surfaces.ts`:
   ```ts
   "lean-native": {
   	tools: ({ tools, shellBuilder }) => shellBuilder ? leanNativeTools(tools) : tools,
   	instructions: (prompt) => prompt.replace(…), // optional
   },
   ```
   `tools` gets the turn's own tools after the builder shell surface is chosen. It also gets `shellBuilder`, `writable`, `freeformPatch` (Codex subscription) and `nativePatch` (OpenAI hosted apply_patch). It runs before MCP, plugin, web-search, plan-mode and secret tools are added and before lifecycle hooks wrap them, so those keep working. `instructions` gets the finished system prompt (builder instructions plus memory). Both run on every durable step: keep them pure and deterministic so the tools and prompt stay byte-stable for prompt caching.
2. If the surface needs different tool construction rather than filtering (e.g. different `apiAgentTools` options), read `variant.toolSurface` next to `harnessSurface` in `src/server/jobs/api-turn.ts` and pass it in.
3. The value is already in `HARNESS_VARIANT_VALUES`. A new key goes there plus `DEFAULT_HARNESS_VARIANT`.
4. Add a test next to `harness-tool-surfaces.test.ts`, deploy dev, and run it side by side with the default: `--variant toolSurface=lean-native` in one process and no flag in another.

## Running side by side

Run the scripts as separate processes. Each one gets its own users, temp directories (`mkdtemp`) and output file (`/tmp/<script>-<time>-<pid>.json`). Rate limits are shared through slot files in `$TMPDIR/ytimesy-eval-slots`. A dead process's slot is reclaimed.

- `codex`: at most 8 concurrent Codex subscription runs across all processes (`YTIMESY_EVAL_CODEX_SLOTS`).
- `openrouter-free`: at most 2 concurrent `:free` runs across all processes (`YTIMESY_EVAL_FREE_SLOTS`), for OpenRouter's 20 requests/min. The smoke suite still checks the day's remaining free requests before it starts. That check is per process, so leave room when several free runs start together.

Examples:

```
node --env-file=.env --import tsx scripts/memory-two-chat-eval.ts --live --arms full --scenarios pnpm-not-npm --repeat 3 --concurrency 3 --variant memoryWording=rules
node --env-file=.env --import tsx scripts/memory-two-chat-eval.ts --live --arms full --scenarios pnpm-not-npm --repeat 3 --concurrency 3
node --env-file=.env --import tsx scripts/native-vs-harness.ts --live --arms harness --repeat 1
node --env-file=.env --import tsx scripts/model-smoke-suite.ts --live --max-cost 0 --models free --tasks count-script,edit-function
```

`--tasks two-tool-calls` is a smoke task that needs two dependent tool calls: read a pointer, then follow it. It fails if the turn made fewer than two tool calls. It runs only when named, so default results stay comparable.

The live edge proof (`scripts/verify-edge-live-turn.ts`) still runs as the owner and needs an empty turn queue. Run it before or after parallel evals, not during them.

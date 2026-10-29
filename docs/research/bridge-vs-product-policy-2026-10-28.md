# Bridge vs product: score-affecting behaviour (2026-10-28)

Goal: a benchmark score we quote must hold in the product. This lists every
score-affecting behaviour that lives only in the Harbor bridge
(`evals/harbor_v2/`), for the scored setup in docs/tb4-astra-run-2026-10-27.md:
`codeMode=on,plan=on,helpers=write,fetch=on,search=function,checks=<proportion|full>`.
Line numbers are on branch `helper-policy-in-product`.

## Moved into product code (this branch)

The delegation policy is now one module, `src/domain/delegation-policy.ts`:
the writer trigger (decide once after the first look; only for two or more
large parts, hours of work or thousands of lines, each built and checked
separately; own files, stated interfaces, integrate and check yourself), the
reader cost bar (over 10 minutes, with other work meanwhile), the brief
contract, keep working / stop instead of waiting, report-is-a-claim and the
refused-start rule. Both the product's orchestration block
(`orchestratorInstructions`, src/domain/subagent-instructions.ts) and the
bridge's `HELPER_INSTRUCTIONS` / `WRITE_HELPER_INSTRUCTIONS`
(evals/harbor_v2/helpers.ts:57, :69) are composed from it. The bridge's text
is byte-identical to before (pinned in tests/harbor-v2-helpers.test.ts).

Only mechanics stay per side:

| Mechanic | Bridge | Product |
| --- | --- | --- |
| Where a writer works | builder's own checkout, limited to `owns` (helpers.ts:271 refuses a writer without `owns`; writes outside are logged, not blocked, helpers.ts:148) | a fork of the builder's VM, returns a patch and git ref (subagent-tools.ts placement `fork`) |
| Where a reader works | its own copy of the checkout | the builder's VM, read-only |
| How reports arrive | `agent_wait` collects them (helpers.ts:297), up to 10 min per wait (helpers.ts:77) | messages that wake the chat; Main hands off and ends its turn |
| Integration | edits already in place | `git diff <base> <ref>`, `git apply -3`, rerun checks |
| Checker role | refused | allowed |

## Still bridge-only (gaps)

| # | Bridge behaviour | Where | Product equivalent | Status |
| --- | --- | --- | --- | --- |
| 1 | `agent_wait`: block to collect helper reports | helpers.ts:297 | Reports arrive as messages and wake an idle chat; `agent` with `wait: true` blocks for a reader | Mechanic, not policy. Equivalent in effect; no gap to close |
| 2 | Writers in the shared checkout limited to `owns` | helpers.ts:69, trial.ts:980 | Writers on VM forks, patches applied by the builder | Mechanic. Writers' cost differs: a product writer pays a VM fork and the builder pays the patch review and apply |
| 3 | Helper budgets: readers 60 steps / 15 min / 1.5M tokens, writers 150 / 45 min / 4M | trial.ts:676, :678 | Level 1: 150 steps / 30 min / 2M tokens, capped at half the parent's remaining (src/domain/subagent.ts:113) | Gap: a bridge writer gets 45 min and 4M tokens, a product writer at most 30 min and 2M. The writer trigger targets "hours of work" parts, so the product writer may run out where the bridge's did not |
| 4 | Helpers run on the builder's model | trial.ts:1119 | Parent's model unless `roleModels` sets one | Same by default |
| 5 | Report capped at 12,000 characters | helpers.ts reportText, children.ts:89 | No equivalent cap found on a child's report message | Small gap; affects context size, not policy |
| 6 | `search=function`: `web_search` as a plain function tool; each call is one low-effort child request carrying the hosted tool | search-tool.ts:11, trial.ts:624, harness.ts:252 | Hosted search tool in every request (api-turn.ts:683, :695) | Gap. Cost only (~2.9K hidden input tokens per request on Bedrock Astra, ~4.4K on the OpenAI API); measured pass rate unchanged. Not built here |
| 7 | `fetch=on`: `web_fetch` for every agent | harness.ts:265 | `src/server/services/web-fetch-tool.ts` exists but api-turn does not wire it | Gap: a scored-setup tool the product lacks |
| 8 | `plan=on`: `update_plan` | trial.ts:1104 | `src/server/services/plan-tool.ts` exists but api-turn does not wire it | Gap: a scored-setup tool the product lacks |
| 9 | `codeMode=on`: `run_code` | harness.ts (codeModeTool) | Supported in api-turn (api-turn.ts:1321) but off in `PRODUCT_HARNESS_VARIANT` (harness-variant.ts:326) | Gap in defaults: product users do not get `run_code` |
| 10 | `helpers=write` itself | trial.ts:1114 | Product has `subagents=on` (PRODUCT_HARNESS_VARIANT) | Policy now shared; tool shapes differ (see mechanics) |
| 11 | Unattended rules: `UNATTENDED_RUN_INSTRUCTIONS` (never stop on a contradiction or missing input) and the brief final answer | rigor.ts:126, harness.ts:344, :366 | None: a person answers questions in a chat | Intentional: no one answers in a trial. A score from tasks with ambiguity partly measures this rule |
| 12 | `checks=proportion` | harness.ts:345 | None (unattended only) | Off in the full setup since 2026-10-27; only affects runs that set it |
| 13 | Background gate: after the run, wait for its background commands and continue with their exit notice, up to 5 rounds | trial.ts:1204, background-gate.ts:22 | background-command-notices.ts wakes an idle chat | Equivalent |
| 14 | `prompt=minimal` | harness.ts:351 | None | Eval-only; not in the scored setup |
| 15 | grind, effortMix, envSnapshot, ledger, goal, review | trial.ts | Review loop exists in the product behind a variant; the rest none | Off in the scored setup; only matter for runs that turn them on |

## Product behaviour change in this branch

Before, the product's block delegated "when it saves wall-clock time": writers
for two or more parts over 5 minutes each or a long build beside a fix, a
reviewer after a hard fix, and a writer's fork for a risky change. Now it
carries the bridge's rules: writers only for large separable parts, decided
once after the first look; readers only for independent investigations over
10 minutes. Product builders will start fewer writers and fewer reviewers.

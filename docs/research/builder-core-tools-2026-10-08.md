# Familiar builder tools

This records the first phase and its measurements. The subsequent
[workflow parity changes](builder-workflow-parity-2026-10-08.md) replace the initial
command surface and bring the current initial core-tool count to 15 plus discovery.

## Concrete gap

Production supplied `bash` outside the shared command-tool factory. The builder
evaluator reused the factory and therefore lacked that shell tool. Discovery also
hid function-based `apply_patch` and exact edits when the batch editor was present,
and hid long-command controls on the first request.

## Change

- Move the existing bounded, turn-scoped shell implementation into
  `apiAgentCommandTools`, reused by production and the evaluator.
- Expose builder patch edits and command start/read/wait/stop immediately, across
  model families. Discovery never manufactures capabilities absent from the
  permission-scoped tool set.
- Limit the initial builder surface to 16 core tools (when permitted), plus tool
  discovery: shell, reads, patch/exact edits, command lifecycle, checks, diff,
  retained output, repository/environment guidance and blocked-task reporting.
  Structured search, outlines, LSP, batch editing, memory, debugging, browser and
  coordination are loaded on demand, not removed. Discovered tools survive
  compaction via the existing durable journal.
- Describe ordinary exploration as shell + `rg`, Git and project CLIs. Retain
  structured search, LSP, batched edits and verification tools; they are useful
  capabilities, not mandatory replacements for shell workflows.
- Preserve replay receipts, cancellation, retained command output, read-only
  leader permissions and final-check requirements. Keep unconditional model
  instructions within the existing 2,200-character budget.

## Verification

Targeted Vitest command:

```sh
pnpm exec vitest run src/server/services/agent-tool-discovery.test.ts src/server/services/api-agent-command-tools.test.ts src/server/services/api-command-scope.test.ts src/server/services/api-agent-file-tools.test.ts src/domain/harness-model-profile.test.ts --maxWorkers=2
```

78 passed, four Linux-only tests skipped on macOS. Typecheck, changed-file Biome
check and production build passed. Production factory tests verify that writable
children receive shell/command tools, while read-only children and root leaders
do not. Shell execution tests use a mocked capture transport;
existing file-tool fixtures execute local Git/Python. No provider inference or
Freestyle VM was launched. This establishes tool wiring and local regression
coverage, not benchmark superiority or live Linux cancellation verification.

The changes are isolated in `builder-core-tools`; the main checkout and concurrent
architecture migration are untouched. Integration must preserve newer uncommitted
changes in the main checkout rather than copying these files wholesale.

## Request-overhead comparison

Compared the committed `e7470f2` discovery policy and model tool instructions with
this worktree using the production writer's 66-tool set. A `MockLanguageModelV4`
captured the actual AI SDK prepared request; no model inference, tools or VMs ran.
The baseline shell description was restored for the before arm. Function-based
patch transport, an empty discovery checkpoint and the same request were used.

| Profile | Before tool JSON characters | After | Reduction |
| --- | ---: | ---: | ---: |
| OpenAI | 17,834 | 13,533 | 24.1% |
| Anthropic | 18,326 | 13,533 | 26.2% |
| Google / other | 17,834 | 13,533 | 24.1% |

OpenAI/Google/other initial tool counts remain 17 including discovery; Anthropic
changes from 18 to 17. The improvement is smaller schemas, not just fewer tools.
OpenAI tool instructions grow from 1,982 to 2,043 characters, leaving the combined
tool-plus-profile text 21.4% smaller. None of the 66 tools is removed.

The private reproduction script is `.ytimesy/builder-core-measure.ts`, with the two
baseline files extracted from Git HEAD. Run `pnpm exec tsx` on that script. These
files are ignored, not committed production dependencies.

This measures prepared request text, not provider-token counts, cache behavior,
task completion time or code quality. Mock execution latency is not meaningful
model latency. A matched live before/after coding evaluation is still necessary;
optional-tool discovery could offset savings for tasks that need those tools.

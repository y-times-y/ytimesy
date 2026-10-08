# Builder workflow improvements

Implemented in the isolated `builder-core-tools` worktree. Not merged, deployed
or benchmarked against native Codex.

## Commands

`execute_command` uses the existing tmux, turn-scoped process registry, command
journal and retained-output capture. One guest RPC starts the command, observes
it for up to ten seconds and returns its actual status/output. A still-running
command yields an owned ID; it is not killed or restarted merely for yielding.

`continue_command` accepts that ID, optional literal stdin text or EOF, a wait
interval and an output cursor. Input is replay-protected; ordinary observations
can retrieve fresh output without repeating input. `stop_command` checks session
ownership before terminating only that command's PID-start-time-fenced process
group and tmux session. Other commands in the turn survive. Turn cancellation
still uses the existing whole-turn stop mechanism.

Commands remain bounded to ten minutes, continuation waits to 55 seconds and
stdin text to 8,192 characters. Credential input and unauthorized publication are
not permitted. Legacy bash/start/read/wait tools remain discoverable for existing
workflows. Durable background-command observation recognizes the new tools, so
compaction/restarts do not hide unfinished command work from publication gates.

The builder's initial surface is now 15 permitted core tools plus discovery.
Read-only leaders still cannot execute, feed or cancel commands.

## Parallel tool calls

The existing AI SDK already executes independent ordinary tool calls concurrently;
the subscription adapter already enables parallel calls. This was not a missing
execution capability. Tool instructions now make that workflow explicit, and a
runtime test holds one read open while another finishes in the same model step.
Dependent calls and shared-file writes must be sequenced.

No new host-side JavaScript evaluator, second orchestration framework, permission
bypass or generic wrapper around approval-sensitive tools was introduced. This
is parallel model tool calling, not an arbitrary-code composition sandbox.

## Images

`view_image` sends actual pixels through the same SDK model-content representation
used by browser screenshots. PNG/JPEG/GIF/WebP images up to 3 MB are supported for
vision-capable models. Images must be repository-relative; URLs, `.git`, traversal,
symlink files/parents, nonregular files and oversized input are rejected. Directory
descriptors and no-follow opens prevent parent-symlink substitution during reads.
The receipt includes the exact byte hash.

Media detection uses the maintained Apache-2.0 `@ai-sdk/provider-utils@5.0.49`
already required by the pinned AI SDK. It is now an explicit direct dependency;
there is no custom format detector or new image decoder. An SDK integration test
confirms pixels reach the next prepared model request rather than becoming only
a JSON string. No live vision-provider inference was performed.

## Verification

- Targeted fixtures: 114 passed, four Linux-only tests skipped on macOS.
- TypeScript, changed-file Biome, production build and diff whitespace checks pass.
- A separate network-disabled, disposable Linux container executes the real
  scoped-command implementation: immediate completion, yielding, stdin, EOF,
  failure status, replay without duplicate execution, foreign-session rejection,
  cancellation and read-only boundaries. The container is removed after running.
- No paid inference, Freestyle VM, database migration or production change.

Reproduce the Linux proof:

```sh
docker build -f scripts/proofs/builder-command.Dockerfile -t ytimesy-builder-tools-proof scripts/proofs
pnpm exec esbuild scripts/prove-builder-command-workflow.ts --bundle --platform=node --format=esm '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' --outfile=.ytimesy/builder-command-proof.mjs
docker run --rm --network none --entrypoint node --mount type=bind,source="$PWD/.ytimesy/builder-command-proof.mjs",target=/proof.mjs,readonly ytimesy-builder-tools-proof /proof.mjs
```

These proofs establish execution behavior, not a general speed/token/code-quality
win. The earlier tool-payload measurement applies to the preceding core-tools
change, before these command/image additions; it must not be presented as the
current combined change's measured gain.

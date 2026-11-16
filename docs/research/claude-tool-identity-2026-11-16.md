# Claude MCP invocation identity — compatibility probe, 2026-11-16

## Question

Can the pinned Claude Agent SDK carry its model `tool_use_id` through a
`PreToolUse` hook into an HTTP MCP call, without exposing a private identity
field in the model-visible tool schema? JSON-RPC counters and input hashes
are not substitutes: counters restart, and identical legitimate calls repeat.

## Result

**Yes for the tested live-process transport; restart durability is not proven.**

The probe used SDK **0.3.321**, a local scripted Messages API, and a local MCP
server. It emitted two tool calls with identical arguments but different model
IDs in one response. The tool schema omitted `__ytimesy_call_id` and explicitly
set `additionalProperties: false`. A `PreToolUse` hook returned `updatedInput`
containing the original arguments plus that private field set to `tool_use_id`.
Both raw MCP requests arrived with the correct, distinct IDs. No tool command
executed and no paid inference was requested.

Research-9 also identified the SDK's existing `params._meta["claudecode/toolUseId"]`
transport by inspecting its pinned binary. I independently verified this with
the probe: **with all hooks disabled and no hidden input field**, both identical
calls in one model response still carried the exact model IDs in that metadata field. Reuse
that native transport rather than introducing an extra tool argument.

Initial hidden-input probe output (before adding native-metadata assertions):

```json
{"sdk":"0.3.321","result":"success","hookIds":["toolu_identity_0","toolu_identity_1"],"receivedIds":["toolu_identity_0","toolu_identity_1"],"calls":2,"strictSchema":true,"paidModelRequests":0,"commandsExecuted":0}
```

## Reproduction and dependencies

`docs/research/claude-tool-identity/probe.mjs` uses Node 20+ standard modules plus
an **already installed SDK 0.3.321**, the same pinned dependency in
`src/domain/guest-cli-pin.ts`. Its default SDK module is the product image's
`/opt/ytimesy-claude-agent-sdk/0.3.321/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`.
`CLAUDE_AGENT_SDK_MODULE` can name another installation's module URL. The probe
needs no account credentials. Run with a sanitized environment, as verified:

```sh
env -i PATH="$PATH" HOME="$HOME" node docs/research/claude-tool-identity/probe.mjs
```

The script binds only an ephemeral localhost port, uses an isolated temporary
home, disables SDK telemetry/updaters, points inference at localhost, and deletes
its temporary directory. Do not supply a real account token. The MCP handler
records arguments only; the command-looking input is never executed.

The clean-copy check exited **0** in 0.92 seconds:

```sh
ytimesy-check --files docs/research/claude-tool-identity/probe.mjs --timeout 120 -- env -i PATH="$PATH" HOME="$HOME" node docs/research/claude-tool-identity/probe.mjs
```

The SDK installation is an explicit external dependency, not a copied sample
from this checkout. Repository Biome ignores `.mjs`; its attempted focused
check exited 1 with no files processed, not a formatting pass.

The extended probe also supports `--native-only`. Its output has empty
`hookIds`, null hidden `receivedIds`, and native IDs `toolu_identity_0` and
`toolu_identity_1`. A subsequent clean-copy run executed both modes and exited
0 in 1.65 seconds. Both modes assert the native metadata IDs exactly. This
proves live-process identity transport; those two modes do not exercise resume.

## Local integration checkpoint

The product handlers now preserve native identity through box forwarding and
the edge bridge, and use it for tool execution IDs. Malformed IDs are refused;
old calls without metadata remain accepted for one deploy. Per-process box
memoization now binds fingerprints and retains failures, with tests covering
partial effects and duplicate calls. This is not deployed and is not a durable
box journal and does not restore lost tool outcomes after a process kill.

## Plain resume after a real process kill

The `--resume-after-kill` mode withholds the first MCP result, verifies that
its model tool ID has reached the SDK's on-disk JSONL transcript, kills only
the SDK child with SIGKILL, and starts a new query with plain `options.resume`
and the same temporary home/session. No rescue/forward environment flags are
set. In the tested pinned SDK:

- The pending tool invocation was not sent to MCP again. Only `toolu_identity_0`
  ever reached the mock tool server.
- The resumed model request contained error tool results marked interrupted for
  both IDs from the original assistant response (the second never executed).
- The resumed query completed successfully. No tool command executed and no
  paid model was contacted.

This also means the earlier two-call test is a same-response identity test,
not proof of overlapping tool execution. Do not infer concurrency from it.

All three modes passed together in a clean copy (exit 0, 4.05 seconds):

```sh
ytimesy-check --files docs/research/claude-tool-identity/probe.mjs --timeout 120 -- sh -c 'env -i PATH="$PATH" HOME="$HOME" node docs/research/claude-tool-identity/probe.mjs && env -i PATH="$PATH" HOME="$HOME" node docs/research/claude-tool-identity/probe.mjs --native-only && env -i PATH="$PATH" HOME="$HOME" node docs/research/claude-tool-identity/probe.mjs --resume-after-kill'
```

This is SDK default-resume evidence, not product-wide recovery: no actual VM
command was in flight, no completed reply was restored from a durable journal,
and the scripted resumed model did not issue a new invocation. It does not
prove that a real model will never choose to repeat an action under a new ID.

## Integration still required

- Preserve `params._meta["claudecode/toolUseId"]` through ytimesy's MCP handlers
  and forwarding calls, binding it to the authorized run/session and a canonical
  input fingerprint. The local handler now preserves metadata. No new model-visible
  input field or PreToolUse injection is needed for the pinned SDK.
- Persist a claim before execution and the completed response before replying.
  A previous claim with no durable outcome must not re-execute the operation.
- Completed duplicates return the recorded result; changed inputs under one ID
  are refused; distinct IDs with identical inputs remain distinct operations.
- Prove durable outcome restoration and full product recovery after runner/VM
  failures. The plain-resume probe above did not reissue the interrupted call,
  but it returned an interrupted result rather than recovering a known outcome.
- Do not put production credentials on the box to implement the journal. The
  existing hibernating feed is a candidate transport, but acknowledgement,
  storage, fencing, fault injection and cost verification remain unimplemented.

No production execution path changed as part of this probe.

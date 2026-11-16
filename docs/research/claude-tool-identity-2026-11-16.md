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

Observed output:

```json
{"sdk":"0.3.321","result":"success","hookIds":["toolu_identity_0","toolu_identity_1"],"receivedIds":["toolu_identity_0","toolu_identity_1"],"calls":2,"strictSchema":true,"paidModelRequests":0,"commandsExecuted":0}
```

## Reproduction and dependencies

`docs/research/claude-tool-identity/probe.mjs` uses Node standard modules plus
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

## Integration still required

- Inject the identity only for ytimesy's MCP calls, extract it before normal
  argument validation, and bind it to the authorized run/session and a canonical
  input fingerprint. Never trust an arbitrary model-supplied private field.
- Persist a claim before execution and the completed response before replying.
  A previous claim with no durable outcome must not re-execute the operation.
- Completed duplicates return the recorded result; changed inputs under one ID
  are refused; distinct IDs with identical inputs remain distinct operations.
- Prove SDK restart/resume reuses the model identity for reissued calls. This
  transport probe does not prove that behavior or durable journal recovery.
- Do not put production credentials on the box to implement the journal. The
  existing hibernating feed is a candidate transport, but acknowledgement,
  storage, fencing, fault injection and cost verification remain unimplemented.

No production execution path changed as part of this probe.

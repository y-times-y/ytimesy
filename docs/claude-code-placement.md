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
  (comma-separated HTTPS origins), `YTIMESY_CLAUDE_RUNNER_SECRET` (32+ chars,
  the same as the boxes' `RUNNER_SIGNING_KEY`), `YTIMESY_CLAUDE_RUNNER_USERS`
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
- **Box disk and cleanup are not built:** sessions of 250 MB fill a small
  volume quickly; the boxes need a large volume and removal of session files
  unused for some days. Changing the box list moves chats to other boxes (they
  fall back to the saved copy, which cannot hold a large session); persist the
  chosen box per chat before the list changes.
- **Not done / not measured:** provisioning the boxes and their HTTPS names
  (Cloudflare Tunnel is the plan); tool-call latency over the extra hop on a
  real network; memory and CPU per `claude` process (about 200 MB resident in
  the localhost benchmark); how Claude behaves with ytimesy's file tools
  instead of its own; drain on scale-in. The box image needs Node at
  `/usr/local/bin/node`, python3, and the pinned Agent SDK installed at the
  path `src/domain/guest-cli-pin.ts` names.

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

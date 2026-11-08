# Turn latency: what was measured, what changed, how to measure again

Written 2026-11-08 after a p90 review of production turns. Everything here
comes from the edge executor's `turn-timing` log lines (Cloudflare Workers
observability, field `ytimesy: "turn-timing"`, with `phases` in ms from the
turn's start) and from the production database. Server side only: browser
network time and the reveal animation are not in these numbers.

## Baseline (Nov 5-8, about 1,200 recorded turns)

| Route | n | first word p50 | p90 | p99 |
| --- | --- | --- | --- | --- |
| Claude Agent (runs Claude Code on the chat's VM) | 46 | 13.3 s | 29.1 s | 229.6 s |
| Codex subscription | 318 | 8.6 s | 12.5 s | 31.2 s |
| API key | 362 | 5.6 s | 10.8 s | 27.2 s |

Machine setup (`checkoutReady`): p50 5.2 s, p90 16 s. 10 of 1,138 turns with a
first word took over 30 s; 7 of those spent over 10 s on machine setup.

## Findings

- **Claude route startup was round trips.** Before the runner started it sent
  about 12 sequential commands to the VM (home, state, SDK check, session
  probe, mkdir, six file writes, launch), each a second or more. The healthy
  gap from checkout ready to first word was 8-15 s.
- **Every progress write carries the whole chat.** `publishApiTurnProgress`
  rewrites `items` on two rows, and the relay reads the session back. A long
  chat is 0.5-1 MB. Shortening the window from 1,500 ms to 250 ms (done for
  smoother streaming) multiplied that cost by six for big chats.
- **Slow turns cluster on single machines.** Chat `abf4a253` spent 16 s
  binding, 57 s on checkout and 119 s on the memory clone in one turn
  (healthy: 1 s, 1.5 s, 3 s) while another chat on another VM stayed at about
  2.5 s for 15 turns in a row, same code and deploy. The cause on that VM is
  not known: no provider credentials exist on the dev machine to look at it.
- **Exit 124 is not always a timeout.** The Freestyle adapter reports 124
  whenever the provider returns no exit status, so "124 with empty stderr" can
  be a stopped guest or a dropped answer, not an expired budget.
- **`egress:vpc` (about 2 s p50 on Codex turns) is the model's time to first
  response header**, not overhead to remove.

## What changed

| Change | Where |
| --- | --- |
| Claude start: state read in one command, SDK check + session restore + grant in parallel, all input files and the launch in one command (3 round trips). Test pins the count. | `src/server/services/claude-code-runner.ts` |
| A poll the machine does not answer is read again (4 in a row, then the turn fails). | same |
| Token lookup and tool definitions overlap the workspace wait. | `src/server/services/claude-code-turn.ts` |
| Path note write and branch read run in parallel for a reused checkout. | `src/server/services/project-workspace.ts` |
| Progress window grows with snapshot size (250 ms small, up to 1,500 ms), measured from the last write's bytes. | `turn-progress-writer.ts`, `adapters/api-turns.ts`, `jobs/api-turn.ts` |
| Smooth reveal spreads each burst over the snapshot cadence it sees, so slower snapshots still flow. | `src/domain/smooth-reveal.ts`, `features/sessions/smooth-text.ts` |
| `git status` of a checkout is retried with 30/60/120 s budgets when it times out; each failed attempt is logged with budget and elapsed time. | `adapters/github/git-proxy-transfer.ts` |
| Machine commands with no exit status are logged (vm, budget, elapsed, stderr tail). A checkout slower than 20 s logs the machine's load, memory, disk and busiest processes. | `adapters/freestyle/workspace-machines.ts`, `services/api-turn-workspace.ts` |

## Not done, on purpose

- **Moving a chat to a fresh machine when its machine is slow.** The cause of a
  slow machine is unproven, and replacing one can lose uncommitted work. The
  two logs above exist to settle the cause first.
- **Delta progress writes** (send only the new text, not the whole chat). The
  real fix for the payload cost; a larger change to the delivery path.

## Measure again

1. Pull `turn-timing` events (Cloudflare Workers observability API, dataset
   `cloudflare-workers`, filter `ytimesy = turn-timing`) for a window after a
   deploy; take `phases.firstToken` and `phases.checkoutReady`.
2. Group by route with `api_turn.connection_revision` (`claude-code:v1`,
   `codex-subscription:v1`, otherwise an API key).
3. Compare p50/p90/p99 with the table above. Separate benchmark traffic from
   real chats before drawing conclusions, and do not compare windows with fewer
   than about 50 turns.
4. Search the logs for `Slow workspace preparation.` and `Machine command
   returned no exit status.` to see why a machine was slow.

# Turn runner boxes

Decision (2026-11-15): API-connection turns (and later Codex's) run their
model loop on AWS "turn runner boxes", not inside the chat's Durable Object.
The chat object stays the coordinator and the live viewers' hub.

## Why

A Durable Object is billed for every second it is awake, and a turn is mostly
waiting on a model's stream or a tool call, during which the object cannot
sleep. Cloudflare is paid out of pocket and capped at the Workers Paid plan,
so its included usage (400k GB-s, 1M Durable Object requests, 10M Worker
requests, 30M CPU ms a month) must cover all users together. AWS runs on
credits. Claude Code turns already work this way: the `claude` process runs on
a runner box and the chat object sleeps between short steps.

## Shape

- `src/server/jobs/box-runner.ts` is the box's process. It claims queued turns
  with executor `node` (`claimApiTurn`), runs each with `runApiTurn` as steps
  (the same code the Durable Object runs), and registers itself in
  `turn_runner_box` every 10 s.
- A turn is routed to the boxes when it is queued (`chooseTurnExecutor`): the
  deployment runs turns in Durable Objects, the user is in
  `YTIMESY_BOX_TURN_USERS` (ids, or `*`), the turn is an API connection's (not
  a Codex or Claude subscription's), and a box with room registered in the last
  45 s. Otherwise the turn runs in its chat's object exactly as before, so a
  down fleet never strands a turn.
- The box keeps the turn's history in process, saves progress to Postgres after
  every model call and tool result (checkpoints; writes cost no egress), and a
  new box loads it from there.

## Crash handling

1. A box that stops (crash, network loss, stop for an upgrade) stops renewing
   the turn's lease (`heartbeat_at`).
2. After 45 s `requeueInterruptedBoxTurns` (run by every box every 15 s and by
   the lease sweep) puts the turn back in the queue with its saved progress,
   `run_attempts + 1`, up to 3 times. A turn asked to stop is not resumed.
3. Another box claims it under a new lease; the old lease's writes are refused,
   so a returning box cannot write over the new one.
4. The new box starts as a resumed step: tool calls the lost box left
   unanswered are closed with an "interrupted, check the workspace first" result
   and never run again; at most the one model reply in flight is requested again.
5. A step that throws on a live box is retried up to 3 times (resumed), then
   the turn is failed (`abandonApiTurn`).
6. The workspace itself lives on the Freestyle VM, not the box.

## Cloudflare budget (the constraint)

Today the room coordinates a turn over HTTP: a lease renewal every 10 s and a
progress relay per update, each a Worker request and a Durable Object request.
From a box that is ~360 requests an hour for renewals alone and thousands for
progress, against ~10,000 Durable Object requests per user per month. So the box
must not talk to the room over HTTP per event. **Before the boxes are enabled for
any user**, coordination and progress go over one hibernatable WebSocket per
turn (a WebSocket message bills at 1/20 of a request), with renewals every 30 s
or less often and progress coalesced. Until then `YTIMESY_BOX_TURN_USERS` stays
empty and nothing is routed to a box.

## No secrets on a box (decided 2026-11-15)

A turn runner box holds no production secret: no database URL, no model
API keys, no token vault key, no Freestyle or GitHub credentials. It is a
thin client of the edge, like Cloudflare's own container egress pattern:

- The box authenticates to the edge with its own short-lived identity
  (rotated, revocable, scoped to "run turns"), never with a shared secret
  that also unlocks anything else.
- Claiming a turn returns a grant scoped to that one turn and its lease:
  the edge, holding the secrets, does the model call (streams it back), the
  workspace tool calls (Freestyle), checkpoint writes and progress, each
  checked against the grant. A lost box exposes at most the turns it was
  running, until their leases end.
- `src/server/jobs/box-runner.ts` as written reads secrets from its
  environment; that path is superseded and must not be provisioned. It stays
  inert until the thin-client edge API replaces its adapters.

## Not yet done

- The thin-client edge API (claim with grant, model proxy, tool bridge,
  checkpoint and progress writes), with box <-> room over one WebSocket
  (above). Required before enabling.
- The box's bootstrap (systemd unit, its identity) with no secrets in it.
- AWS: launching the boxes (the current key cannot create or list resources).
- Codex subscription turns (they reach ChatGPT through a Cloudflare egress path).
- Measure per-turn memory on a real box to set `YTIMESY_TURN_BOX_CAPACITY`.

## Sizing

`t3.small` (2 vCPU, 2 GB, ~$15/month + ~$8 disk) fits roughly 8-10 concurrent
turns. A `t4g.small` is ~20% cheaper but the Claude runner boxes are x86
(pinned x64 Claude binary), so ARM needs a test box first. Size the fleet from
measured concurrency.

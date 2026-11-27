# Dev rollout checklist: Y², Cloudflare budget, turn runner boxes

Status 2026-11-17. Everything below is built on branch `y2-super-agent` and
tested only with fakes. Nothing is deployed, no AWS box runs it, and every
feature is off by default. Each step needs the owner's approval. Do development
first; do not touch production until the dev run is measured.

## 0. Before anything

- [ ] Merge or rebase `y2-super-agent` onto the current `main` (it was cut from
      `ad915d15`, 2026-11-16) and rerun `pnpm exec tsc --noEmit` and the related
      suites. Known baseline failures that are NOT from this work:
      `src/server/jobs/api-turn.test.ts` 18, `src/server/adapters/` 19,
      `tests/api-turns.test.ts` 35 (missing env in the test database).
- [ ] Generate the edge types first on a fresh checkout:
      `pnpm exec wrangler types -c wrangler.edge-executor.jsonc --path .ytimesy/edge-executor-runtime.d.ts`.

## 1. Database migrations (development database first)

Apply in this order, before deploying the code that reads them:

1. `20261112120000_y_mode.sql` (keeps its original name: the development database already recorded it under that version) adds `project.y_enabled`, `agent_session.chat_role`
   and the one-Y²-per-project index. The widened chat scope query reads
   `project.y_enabled` on every step, so deploying code first fails every step.
2. `20261117120000_turn_runner_box_revocation.sql` adds `turn_runner_box.revoked_at`.

- [ ] Run each inside a rolled-back transaction on the development database first
      (the way `docs/y.md` says the Y migration was checked), then apply.

## 2. Cloudflare edge worker (development)

Changes in `wrangler.edge-executor.jsonc`: a new Durable Object binding
`Y_SQUARED_CREWS` (class `YSquaredCrew`) in dev and production, and migration
tag `v5` (`new_sqlite_classes: ["YSquaredCrew"]`).

- [ ] Deploy with `scripts/deploy-edge-development.ts` (dev only).
- [ ] Check the new class exists and `UserHub`/`ModelConversation` still answer.
- [ ] No new Worker or Durable Object is billed until a Y project or a boxed
      user exists; metering code adds one SQLite row write per chat step.

## 3. Cloudflare budget meter (docs/cloudflare-budget.md)

- [ ] Leave the `YTIMESY_CF_BUDGET_*` defaults (4,000 GB-s, 10,000 DO requests,
      100,000 Worker requests, degrade at 70%) and `YTIMESY_CF_BUDGET_GLOBAL=off`.
- [ ] In the Cloudflare dashboard set the Workers and Durable Objects spending
      limits and email alerts at 50/70/90% as the backstop (the app meter is
      soft and fails open).
- [ ] Calibrate: query `durableObjectsPeriodicGroups` (same source as
      `docs/infrastructure-optimization-status-2026-11-16.md`) for a day and
      compare with the per-user totals in `UserHub.usage()`. The meter does not
      count idle in-memory time, so expect it to under-count.
- [ ] Known gap: a blocked user's message ("Monthly compute budget reached,
      resets on the 1st") is only logged; the chat shows a queued turn.

## 4. Y² on one development project

- [ ] Turn on Project settings → Y² → "Use Y²" for one dev project only.
- [ ] Check: the Y² chat is created once, `threads` reads the crew object (watch
      Postgres egress for the project: should be ~0 transcript reads), a thread
      finishing wakes Y² once per 45 s batch (cap 12/hour), Y²'s own turns never
      wake it, a Y² turn never provisions a VM.
- [ ] Try `start_thread`, `message_thread`, `stop_thread` on throwaway threads:
      admission still applies (32 per user, usage windows, Freestyle budget).
- [ ] Known gap: if a settled turn's history lacks the question card, the crew row
      says `finished` without `waitingOn` (the api-turn fallback is not built).

## 5. Turn runner boxes (only after 1-4 are clean)

Keys and secrets, none of which exist yet:

- [ ] `TURN_BOX_EDGE_PRIVATE_KEY` and `TURN_BOX_EDGE_PUBLIC_KEY` (Ed25519). The
      private key lives only in the edge Worker's secrets. Put it in the owner's
      production secret bundle the way `docs/claude-code-placement.md` describes for
      the Claude runner signing key; never on an AWS box. The box gets the public
      key and its own `ytbi1.` identity (24 h, revocable).
- [ ] `YTIMESY_BOX_TURN_USERS` set to ONE dev user id (never `*`). Rollback:
      empty it; routing falls back to the Durable Object for new turns.

AWS (needs explicit approval; the key on this machine may not be allowed to create
resources, `docs/turn-runner-boxes.md` says it cannot):

- [ ] One outbound-only `t3.small`, no inbound ports, no tunnel, **no secrets**:
      the box start-up guard refuses to run if it sees a database URL, provider
      key, vault/signing secret, or Freestyle, GitHub, storage or AWS credential.
- [ ] Capacity setting low (~6 turns) until memory per turn is measured.

Shadow run before real traffic:

- [ ] Measure per 40-step turn: Worker requests (fakes: ~102; target ≤100), DO
      requests (target ≤10), memory per turn on the box, added latency per step.
- [ ] Kill the box mid-turn: lease expires (45 s), the turn requeues with saved
      progress, up to 3 attempts, then falls back to the Durable Object.
- [ ] Stop mid-turn pushes cancel to the box; a stale box writes nothing.

## 6. What still cannot run on a box (stay on the Durable Object)

Subscription routes (Claude Code, Codex, Grok plan), helper chats, evaluation
runs, projects with runtime secrets (unless `YTIMESY_CLAUDE_BOX_TOOLS_SECRETS=1`),
MCP servers (a box runs with none), saving a secret from the secret tool, push
approval, failover to another connection. About 26 modules are tracked as debt in
`turn-box-bundle-imports.test.ts`; compaction, attachments and background commands
may reach them.

## 7. Provider limits to keep in view

- Cloudflare Workers Paid: 10M Worker requests; DO 1M requests, 400,000 GB-s, 50M
  rows written. Zero overage is the rule; Cloudflare has no hard cap.
- Supabase: ~1.7 GB/day of logged large reads today (`scripts/egress-report.ts`).
  Plan allowance not recorded here.
- Freestyle: allowance is small (200 vCPU-h, 400 GiB-h); VM hours are paid from
  credits. Per-user concurrency (32) and the monthly compute ceiling are the bar.

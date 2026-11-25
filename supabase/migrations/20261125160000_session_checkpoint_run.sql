-- In-flight lease for a session's checkpoint capture. The per-minute backstop
-- used to start a new capture (a new Durable Object) every tick while the last
-- one was still running; now one run holds this row until it finishes or its
-- lease expires, and the number of live rows caps concurrent captures.
-- Additive; server-only.
create table if not exists session_checkpoint_run (
  session_id uuid primary key references agent_session(id) on delete cascade,
  lease_id uuid not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists session_checkpoint_run_expires_idx on session_checkpoint_run (expires_at);
alter table session_checkpoint_run enable row level security;
revoke all on session_checkpoint_run from anon, authenticated;

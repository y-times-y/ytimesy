-- Continuous interruption monitoring (docs/interruption-monitoring.md).
-- interruption_event: one best-effort row per interruption of a chat turn
-- (rate limited per kind and turn by the writer, pruned after 35 days).
-- canary_run: one row per synthetic canary run.
-- Bookkeeping only: nothing reads these rows to decide anything about a turn.
create table if not exists interruption_event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) <= 60),
  turn_id text check (turn_id is null or char_length(turn_id) <= 100),
  session_id text check (session_id is null or char_length(session_id) <= 100),
  cause text not null default 'unknown' check (char_length(cause) <= 120),
  recovered boolean not null default false,
  user_visible boolean not null default false
);
create index if not exists interruption_event_at on interruption_event(at);
create index if not exists interruption_event_kind_turn on interruption_event(kind, turn_id, at);

-- ok is null while the run waits for its answers (checked on later ticks).
create table if not exists canary_run (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ok boolean,
  session_id text check (session_id is null or char_length(session_id) <= 100),
  nonce text not null check (char_length(nonce) <= 60),
  baseline_items integer not null default 0,
  checked_at timestamptz,
  failure text check (failure is null or char_length(failure) <= 500)
);
create index if not exists canary_run_at on canary_run(at);

-- Server-only data: never exposed through the Data API.
alter table interruption_event enable row level security;
alter table canary_run enable row level security;
revoke all on interruption_event from anon, authenticated;
revoke all on canary_run from anon, authenticated;

alter table owner_alert drop constraint owner_alert_kind_check;
alter table owner_alert add constraint owner_alert_kind_check
  check (kind in ('fleet-budget','abandoned-turns','cron-failure','email-failed','codex-egress','chat-wake-failed','interruption','interruption-digest','canary-failed'));

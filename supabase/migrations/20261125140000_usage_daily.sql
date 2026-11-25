-- Daily token usage per user, for the Usage page's totals and heatmap.
-- Written once per settled turn (usage_turn_counted makes that idempotent, so
-- the backfill and a retried finish never double count); read by one indexed
-- range scan per user and year, never by scanning api_turn.
create table if not exists usage_daily (
  user_id text not null references auth_user(id) on delete cascade,
  day date not null,
  provider text not null check (provider in ('anthropic','openai','xai','google','other')),
  model_id text not null,
  project_id uuid references project(id) on delete set null,
  source text not null check (source in ('box','durable-object','y2')),
  turns integer not null default 0,
  -- Turns that reported no token counts (subscription runtimes): unknown, not zero.
  unknown_turns integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0
);
create unique index if not exists usage_daily_key on usage_daily(
  user_id, day, provider, model_id, source,
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create index if not exists usage_daily_project on usage_daily(project_id)
  where project_id is not null;

create table if not exists usage_turn_counted (
  turn_id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade
);

alter table usage_daily enable row level security;
alter table usage_turn_counted enable row level security;
revoke all on usage_daily, usage_turn_counted from anon, authenticated;
-- The test account's usage seeding (docs/testing-live.md) is recorded like mint and reset.
alter table test_session_event drop constraint if exists test_session_event_action_check;
alter table test_session_event add constraint test_session_event_action_check
  check (action in ('minted', 'refused', 'reset', 'seeded-usage'));

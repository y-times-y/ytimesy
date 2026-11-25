-- The synthetic canary's target (docs/interruption-monitoring.md): one row, set by an operator.
-- Used when the YTIMESY_CANARY_* environment variables are not set. Additive; server-only.
create table if not exists canary_config (
  singleton boolean primary key default true check (singleton),
  user_id text not null check (char_length(user_id) <= 200),
  project_id text not null check (char_length(project_id) <= 100),
  model_id text not null check (char_length(model_id) <= 200),
  updated_at timestamptz not null default now()
);
alter table canary_config enable row level security;
revoke all on canary_config from anon, authenticated;

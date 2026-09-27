alter table agent_session drop constraint agent_session_harness_check;
alter table agent_session add constraint agent_session_harness_check
  check (harness in ('codex','claude','opencode','api'));

create table api_turn (
  id uuid primary key,
  session_id uuid not null references agent_session(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  connection_id uuid references model_connection(id) on delete set null,
  model_id text not null,
  connection_revision text not null,
  state text not null check (state in ('queued','running','completed','failed','cancelled')),
  messages jsonb not null default '[]',
  items jsonb not null default '[]',
  cancel_requested boolean not null default false,
  lease_id uuid,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index api_turn_one_active on api_turn(session_id)
  where state in ('queued','running');
create index api_turn_worker on api_turn(state,created_at);
alter table api_turn enable row level security;
revoke all on api_turn from anon, authenticated;

create table api_usage_budget (
  user_id text not null references auth_user(id) on delete cascade,
  scope text not null,
  day date not null default (now() at time zone 'UTC')::date,
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  primary key(user_id,scope,day)
);
alter table api_usage_budget enable row level security;
revoke all on api_usage_budget from anon, authenticated;

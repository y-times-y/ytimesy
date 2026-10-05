-- Operator-only evaluation limits. Ordinary application turns have no matching row.
create table public.harness_evaluation_run (
 id uuid primary key default gen_random_uuid(),
 user_id text not null references public.auth_user(id) on delete cascade,
 root_session_id uuid not null unique references public.agent_session(id) on delete cascade,
 model_id text not null,
 connection_revision text not null,
 deadline timestamptz not null,
 max_requests integer not null check (max_requests between 1 and 100),
 max_tokens bigint not null check (max_tokens between 1000 and 4000000),
 requests integer not null default 0 check (requests >= 0),
 observed_tokens bigint not null default 0 check (observed_tokens >= 0),
 state text not null default 'active' check (state in ('active','stopped','completed')),
 created_at timestamptz not null default now()
);
create table public.harness_evaluation_usage (
 run_id uuid not null references public.harness_evaluation_run(id) on delete cascade,
 turn_id uuid not null references public.api_turn(id) on delete cascade,
 observed_tokens bigint not null check (observed_tokens >= 0),
 primary key (run_id,turn_id)
);
alter table public.harness_evaluation_run enable row level security;
alter table public.harness_evaluation_usage enable row level security;
revoke all on public.harness_evaluation_run,public.harness_evaluation_usage from anon,authenticated;

alter table agent_session
 add column task_branch text,
 add column task_pull_request_url text;

create table agent_task_event (
 id uuid primary key,
 user_id text not null references auth_user(id) on delete cascade,
 parent_session_id uuid not null references agent_session(id) on delete cascade,
 child_session_id uuid not null references agent_session(id) on delete cascade,
 event_type text not null check (event_type in ('completed','failed','blocked')),
 dedupe_key text not null unique,
 payload jsonb not null,
 status text not null default 'pending' check (
  status in ('pending','delivering','delivered')
 ),
 attempts integer not null default 0,
 available_at timestamptz not null default now(),
 delivered_at timestamptz,
 last_error text,
 created_at timestamptz not null default now()
);

create index agent_task_event_pending
 on agent_task_event(available_at, created_at)
 where status in ('pending','delivering');

alter table agent_task_event enable row level security;
revoke all on agent_task_event from public, anon, authenticated;

alter table api_turn add column idempotency_key text;
create unique index api_turn_idempotency on api_turn(session_id,idempotency_key) where idempotency_key is not null;

create table agent_pr_repair_control (
 session_id uuid primary key references agent_session(id) on delete cascade,
 attempts integer not null default 0 check(attempts between 0 and 3),
 paused boolean not null default false,
 updated_at timestamptz not null default now()
);
create table agent_pr_repair_event (
 delivery_id uuid not null,
 session_id uuid not null references agent_session(id) on delete cascade,
 head_sha text not null check(head_sha ~ '^[a-f0-9]{40}$'),
 signal jsonb not null,
 status text not null default 'pending' check(status in ('pending','dispatching','delivered','ignored','blocked')),
 counted boolean not null default false,
 failures integer not null default 0 check(failures between 0 and 5),
 available_at timestamptz not null default now(),
 last_error text,
 created_at timestamptz not null default now(),
 primary key(delivery_id,session_id)
);
create index agent_pr_repair_pending on agent_pr_repair_event(available_at,created_at) where status in ('pending','dispatching');
alter table agent_pr_repair_control enable row level security;
alter table agent_pr_repair_event enable row level security;
revoke all on agent_pr_repair_control,agent_pr_repair_event from public,anon,authenticated;

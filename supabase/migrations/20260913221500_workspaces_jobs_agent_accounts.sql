-- Durable per-user workspace and agent-account records. pg-boss owns tables
-- inside job_queue and migrates them at process start; do not duplicate that DDL.
create schema if not exists job_queue;
revoke all on schema job_queue from public, anon, authenticated;
alter default privileges in schema job_queue revoke all on tables from public, anon, authenticated;
alter default privileges in schema job_queue revoke all on sequences from public, anon, authenticated;
alter default privileges in schema job_queue revoke all on functions from public, anon, authenticated;

create table workspace (
 id uuid primary key,
 user_id text not null references auth_user(id) on delete cascade,
 project_id uuid not null references project(id) on delete cascade,
 status text not null check (status in ('queued','provisioning','cloning','installing','ready','failed')),
 provider_ref text,
 error_message text,
 last_job_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (project_id)
);
create index workspace_owner on workspace(user_id, updated_at desc);

create table workspace_event (
 id uuid primary key,
 workspace_id uuid not null references workspace(id) on delete cascade,
 user_id text not null references auth_user(id) on delete cascade,
 message text not null,
 created_at timestamptz not null default now()
);
create index workspace_event_log on workspace_event(workspace_id, created_at);

create table agent_account (
 user_id text primary key references auth_user(id) on delete cascade,
 provider text not null check (provider = 'codex'),
 status text not null check (status in ('disconnected','connected','expired')),
 encrypted_snapshot_id text,
 plan_type text,
 email text,
 message text,
 updated_at timestamptz not null default now()
);

alter table workspace enable row level security;
alter table workspace_event enable row level security;
alter table agent_account enable row level security;
revoke all on workspace, workspace_event, agent_account from anon, authenticated;

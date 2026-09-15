-- Project environment snapshots and per-agent session VMs.
-- The workspace row is the prepared template. agent_session owns the copy
-- an agent actually edits. Competing agents never share a checkout.

alter table workspace
 add column template_snapshot_id text;

create table agent_session (
 id uuid primary key,
 user_id text not null references auth_user(id) on delete cascade,
 project_id uuid not null references project(id) on delete cascade,
 workspace_id uuid not null references workspace(id) on delete cascade,
 harness text not null check (harness in ('codex','claude','opencode')),
 provider_ref text,
 title text not null default 'New session',
 briefing text,
 items jsonb not null default '[]'::jsonb,
 status text not null check (status in ('starting','ready','failed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index agent_session_owner on agent_session(user_id, project_id, updated_at desc);

create table project_briefing (
 project_id uuid primary key references project(id) on delete cascade,
 text text not null default '',
 updated_at timestamptz not null default now()
);

create table project_trace (
 id uuid primary key,
 project_id uuid not null references project(id) on delete cascade,
 session_id uuid references agent_session(id) on delete set null,
 area text,
 summary text not null,
 created_at timestamptz not null default now()
);
create index project_trace_project on project_trace(project_id, created_at desc);

alter table agent_session enable row level security;
alter table project_briefing enable row level security;
alter table project_trace enable row level security;
revoke all on agent_session, project_briefing, project_trace from anon, authenticated;

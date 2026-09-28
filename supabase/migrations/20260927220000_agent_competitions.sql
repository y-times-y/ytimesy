create table agent_competition (
 root_session_id uuid primary key references agent_session(id) on delete cascade,
 user_id text not null references auth_user(id) on delete cascade,
 project_id uuid not null references project(id) on delete cascade,
 prompt text not null,
 harness text not null check (harness in ('codex','claude','api')),
 model_id text not null,
 leader_count smallint not null check (leader_count between 2 and 5),
 status text not null default 'queued' check (status in ('queued','working','judging','complete','failed')),
 winner_session_id uuid references agent_session(id) on delete set null,
 error_message text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

alter table agent_session add column candidate_index smallint check (candidate_index between 1 and 5);
create unique index agent_session_candidate_position on agent_session(parent_session_id,candidate_index)
 where candidate_index is not null;

alter table agent_competition enable row level security;
revoke all on agent_competition from public, anon, authenticated;
create index agent_competition_owner on agent_competition(user_id,project_id,created_at desc);

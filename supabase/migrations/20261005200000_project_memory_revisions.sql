create table project_memory_revision (
 id uuid primary key,
 project_id uuid not null references project(id) on delete cascade,
 session_id uuid references agent_session(id) on delete set null,
 memory_key text not null check (memory_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 document_revision text not null check (document_revision ~ '^[a-f0-9]{64}$'),
 operation text not null check (operation in ('remember', 'consolidate')),
 previous_text text not null,
 next_text text not null,
 created_at timestamptz not null default now()
);
create index project_memory_revision_lookup on project_memory_revision(project_id,memory_key,created_at desc,id);
alter table project_memory_revision enable row level security;
revoke all on project_memory_revision from anon, authenticated;

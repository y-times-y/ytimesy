-- Project secrets the agent can use as env vars. Values stay encrypted at rest.
create table project_secret (
 id uuid primary key,
 project_id uuid not null references project(id) on delete cascade,
 name text not null,
 hint text not null,
 encrypted_iv text not null,
 encrypted_tag text not null,
 encrypted_ciphertext text not null,
 encrypted_version smallint not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (project_id, name)
);
create index project_secret_project on project_secret(project_id, name);
alter table project_secret enable row level security;
revoke all on project_secret from anon, authenticated;

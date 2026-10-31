-- A project's environment setup, per repository, kept in ytimesy: written by
-- the setup agent or edited in Settings > Project. Every save is a new row;
-- the newest per repository is what builds use, ahead of a repository's own
-- .ytimesy/environment.json (as Cursor's saved environments do).
create table project_environment_recipe (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  repository_id bigint not null,
  recipe jsonb not null,
  source text not null check (source in ('agent', 'user', 'import')),
  summary text check (summary is null or char_length(summary) <= 300),
  created_at timestamptz not null default now()
);
create index project_environment_recipe_latest
  on project_environment_recipe(project_id, repository_id, created_at desc);
alter table project_environment_recipe enable row level security;
revoke all on project_environment_recipe from anon, authenticated;

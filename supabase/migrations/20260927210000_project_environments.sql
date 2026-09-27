-- Existing project columns remain the primary repository for compatibility.
alter table public.project add column if not exists name text;
alter table public.project add column repository_set_key text not null default '';
alter table public.project drop constraint project_user_id_repository_id_key;
alter table public.project add unique(user_id,repository_id,repository_set_key);
create table public.project_repository (
  project_id uuid not null references public.project(id) on delete cascade,
  repository_id bigint not null,
  installation_id bigint not null,
  full_name text not null,
  branch text not null,
  position integer not null check (position >= 0),
  primary key (project_id, repository_id),
  unique (project_id, position)
);
insert into public.project_repository(project_id,repository_id,installation_id,full_name,branch,position)
select id,repository_id,installation_id,full_name,branch,0 from public.project;
alter table public.project_repository enable row level security;
revoke all on public.project_repository from anon, authenticated;

create function public.sync_primary_project_repository() returns trigger language plpgsql set search_path=public as $$
begin
  if new.repository_set_key='' then
    insert into project_repository(project_id,repository_id,installation_id,full_name,branch,position)
    values(new.id,new.repository_id,new.installation_id,new.full_name,new.branch,0)
    on conflict(project_id,repository_id) do update set installation_id=excluded.installation_id,full_name=excluded.full_name,branch=excluded.branch;
  end if;
  return new;
end;
$$;
create trigger project_primary_repository after insert or update of branch,full_name,installation_id on public.project for each row execute function public.sync_primary_project_repository();

create table public.environment_build (
  id uuid primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  status text not null check (status in ('running','ready','failed')),
  input_hash text not null,
  sources jsonb not null,
  snapshot_id text,
  provider_ref text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index environment_build_workspace_created on public.environment_build(workspace_id,created_at desc);
create unique index environment_build_one_running on public.environment_build(workspace_id) where status='running';
alter table public.environment_build enable row level security;
revoke all on public.environment_build from anon, authenticated;

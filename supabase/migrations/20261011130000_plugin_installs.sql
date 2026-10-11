-- Plugins installed from our reviewed catalog, pinned to the reviewed commit.
-- Components are stored at install; user settings that are sensitive are sealed.
create table plugin_install (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid references project(id) on delete cascade,
  catalog_id text not null check (catalog_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  plugin_name text not null,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  components jsonb not null check (jsonb_typeof(components) = 'object'),
  sealed_config text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index plugin_install_owner_catalog on plugin_install(user_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), catalog_id);
alter table plugin_install enable row level security;
revoke all on plugin_install from anon, authenticated;

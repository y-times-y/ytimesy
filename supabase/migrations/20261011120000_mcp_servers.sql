-- Remote (HTTP) MCP servers a user connects in settings. Our server calls them;
-- sealed headers never enter workspace VMs and are never read back to clients.
create table mcp_server (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid references project(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  url text not null check (url ~ '^https://' and length(url) <= 2048),
  sealed_headers text,
  header_names text[] not null default '{}',
  plugin_id text check (plugin_id is null or length(plugin_id) between 1 and 200),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index mcp_server_owner_name on mcp_server(user_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
alter table mcp_server enable row level security;
revoke all on mcp_server from anon, authenticated;

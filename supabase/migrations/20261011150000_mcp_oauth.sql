-- MCP servers that sign in with OAuth (the MCP authorization spec). Client
-- registration and tokens are sealed; they never reach clients or VMs.
alter table mcp_server add column auth text not null default 'headers'
  check (auth in ('headers', 'oauth'));
alter table mcp_server add column sealed_oauth text;

create table mcp_oauth_state (
  state_hash text primary key,
  user_id text not null references auth_user(id) on delete cascade,
  server_id uuid not null references mcp_server(id) on delete cascade,
  encrypted_verifier text not null,
  expires_at timestamptz not null
);
alter table mcp_oauth_state enable row level security;
revoke all on mcp_oauth_state from anon, authenticated;

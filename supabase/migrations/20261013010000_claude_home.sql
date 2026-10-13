-- Encrypted Claude Code home files per user. They were kept in a local file,
-- which a Worker cannot read or write. Sealed with the server master key.
create table claude_home (
  user_id text primary key references auth_user(id) on delete cascade,
  encrypted jsonb not null,
  updated_at timestamptz not null default now()
);
alter table claude_home enable row level security;
revoke all on claude_home from anon, authenticated;

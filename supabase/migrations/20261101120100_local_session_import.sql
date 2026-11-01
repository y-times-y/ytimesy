-- "Continue your agent session": importing local coding-agent sessions
-- (Claude Code, Codex, OpenCode, Pi, Grok, ...) through `npx ytimesy continue`.
--
-- local_import: one import, started from the web card. The card's one-time
-- code and the CLI's token are stored only as SHA-256 hashes. The code lives
-- 15 minutes and is spent by the CLI's start call, which issues the token
-- (about 2 hours). Every CLI call is scoped to the import's user.
create table local_import (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  code_hash text not null unique,
  code_expires_at timestamptz not null,
  code_used_at timestamptz,
  token_hash text unique,
  token_expires_at timestamptz,
  status text not null default 'waiting'
    check (status in ('waiting', 'connected', 'importing', 'ready', 'failed')),
  -- The local agent that ran the command, as the CLI reported it.
  agent text check (agent is null or char_length(agent) <= 40),
  sessions_planned integer not null default 0 check (sessions_planned >= 0),
  sessions_imported integer not null default 0 check (sessions_imported >= 0),
  -- Set by finish: the continued project and its handoff chat.
  project_id uuid references project(id) on delete set null,
  session_id uuid references agent_session(id) on delete set null,
  message text check (message is null or char_length(message) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index local_import_user on local_import(user_id, created_at desc);
alter table local_import enable row level security;
revoke all on local_import from anon, authenticated;

-- One imported local session, attached to one project (never global across
-- projects). Its handoff JSON and full transcript archive are sealed objects
-- in the private R2 bucket under handoff/<sha256(user)>/<sha256(project)>/<id>/;
-- chats in the project get the transcripts at ~/.ytimesy/handoff/.
-- Importing the same local session again replaces the row (and its objects).
create table local_import_session (
  id uuid primary key,
  import_id uuid references local_import(id) on delete set null,
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid not null references project(id) on delete cascade,
  tool text not null check (tool in ('claude', 'codex', 'opencode', 'pi', 'grok', 'gemini', 'cursor')),
  source_session_id text not null check (char_length(source_session_id) between 1 and 200),
  title text not null default '' check (char_length(title) <= 300),
  turn_count integer not null default 0 check (turn_count >= 0),
  source_started_at timestamptz,
  source_updated_at timestamptz not null,
  handoff_bytes integer not null check (handoff_bytes >= 0),
  -- Null until the transcript archive arrives.
  transcript_bytes integer check (transcript_bytes is null or transcript_bytes >= 0),
  created_at timestamptz not null default now(),
  unique (project_id, tool, source_session_id)
);
create index local_import_session_project
  on local_import_session(project_id, source_updated_at desc);
alter table local_import_session enable row level security;
revoke all on local_import_session from anon, authenticated;

-- Secrets the CLI read from a local .env / .env.local: shown in Settings with
-- an "Imported" badge until the user saves or removes them.
alter table project_secret add column imported_at timestamptz;

-- Abuse limits for creating import codes and for the CLI's calls.
alter table user_action_rate drop constraint user_action_rate_action_check;
alter table user_action_rate add constraint user_action_rate_action_check
  check (action in ('chat-send', 'project-create', 'vm-create', 'local-import-code', 'local-import-call'));

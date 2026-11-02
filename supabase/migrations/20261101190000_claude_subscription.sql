-- Claude Code on the user's own Claude Pro/Max subscription. The token from
-- `claude setup-token` is sealed in the token vault (purpose
-- claude-subscription, bound to the user) and never returned to a browser
-- or written to a VM: the edge proxy swaps it in for a per-turn grant.
create table claude_subscription (
  user_id text primary key references auth_user(id) on delete cascade,
  sealed_token text not null,
  -- refused: Anthropic answered 401/403 for it; limited: the plan's window is spent.
  status text not null check (status in ('connected', 'refused', 'limited')),
  message text check (message is null or char_length(message) <= 300),
  limited_until timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table claude_subscription enable row level security;
revoke all on claude_subscription from anon, authenticated;

-- Model requests each Claude Code turn made through the proxy (its cap).
create table claude_code_turn_request (
  turn_id uuid primary key references public.api_turn(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  requests integer not null default 0 check (requests >= 0),
  updated_at timestamptz not null default now()
);
alter table claude_code_turn_request enable row level security;
revoke all on claude_code_turn_request from anon, authenticated;

-- The Claude Code session a chat resumes, and where its saved transcript
-- (the session JSONL, sealed in checkpoint storage) is, so a new VM can resume.
create table claude_code_session (
  session_id uuid primary key references public.agent_session(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  claude_session_id uuid not null,
  transcript_path text check (transcript_path is null or char_length(transcript_path) <= 512),
  cwd text not null check (char_length(cwd) <= 1024),
  updated_at timestamptz not null default now()
);
alter table claude_code_session enable row level security;
revoke all on claude_code_session from anon, authenticated;

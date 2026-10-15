-- Cross-chat memory (Agent Memory Repo). The memory itself is a private Git
-- repo per user in Cloudflare Artifacts; these tables hold only its settings,
-- an embedding cache for the read hook, and the model usage of memory jobs.

-- mode: off | spec (the spec's loop and dreaming) | full (plus read/save hooks).
-- repo overrides the default repo name memory-<user_id> (evaluations).
-- dreamed_through: the newest chat activity the last dream covered.
create table user_memory (
  user_id text primary key references auth_user(id) on delete cascade,
  mode text not null default 'full' check (mode in ('off','spec','full')),
  repo text check (repo ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
  dreamed_through timestamptz,
  updated_at timestamptz not null default now()
);
alter table user_memory enable row level security;
revoke all on user_memory from anon, authenticated;

-- One embedding per distinct memory line text; unchanged lines are never re-embedded.
create table memory_line_embedding (
  user_id text not null references auth_user(id) on delete cascade,
  model text not null,
  line_hash text not null check (line_hash ~ '^[a-f0-9]{64}$'),
  embedding real[] not null,
  created_at timestamptz not null default now(),
  primary key (user_id, model, line_hash)
);
alter table memory_line_embedding enable row level security;
revoke all on memory_line_embedding from anon, authenticated;

-- Model usage of the save hook and dreaming, which run on the user's own model route.
create table memory_model_usage (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null check (kind in ('save','dream')),
  session_id uuid,
  model_id text not null,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  steps integer not null default 0,
  outcome text not null,
  created_at timestamptz not null default now()
);
create index memory_model_usage_user on memory_model_usage(user_id, created_at desc);
alter table memory_model_usage enable row level security;
revoke all on memory_model_usage from anon, authenticated;

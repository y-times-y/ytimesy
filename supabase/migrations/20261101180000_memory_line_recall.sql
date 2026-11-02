-- When each memory line (by a hash of its normalized text, so a line moved
-- between folders keeps its record) was last attached to a request. Dreams
-- use it to retire lines no chat has used for a long time.
create table memory_line_recall (
  user_id text not null references auth_user(id) on delete cascade,
  line_hash text not null check (line_hash ~ '^[a-f0-9]{64}$'),
  first_recalled_at timestamptz not null default now(),
  recalled_at timestamptz not null default now(),
  recall_count integer not null default 1,
  primary key (user_id, line_hash)
);
alter table memory_line_recall enable row level security;
revoke all on memory_line_recall from anon, authenticated;

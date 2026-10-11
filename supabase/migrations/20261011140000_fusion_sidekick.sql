-- Fusion: the sidekick's own persistent context, one per lead session.
-- The messages live in the encrypted checkpoint store; this row points at the latest.
create table fusion_sidekick (
  session_id uuid primary key references agent_session(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  model_id text not null,
  checkpoint_path text not null,
  updated_at timestamptz not null default now()
);
alter table fusion_sidekick enable row level security;
revoke all on fusion_sidekick from anon, authenticated;

create table public.session_checkpoint (
 session_id uuid primary key references public.agent_session(id) on delete cascade,
 user_id text not null,
 object_path text not null,
 turn_fingerprint text not null,
 executor_id text not null,
 runner_id text,
 created_at timestamptz not null default now()
);
alter table public.session_checkpoint enable row level security;
revoke all on public.session_checkpoint from anon, authenticated;

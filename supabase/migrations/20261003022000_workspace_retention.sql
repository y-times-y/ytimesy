create table public.workspace_retention (
  session_id uuid primary key references public.agent_session(id) on delete cascade,
  user_id text not null references public.auth_user(id),
  vm_id text not null,
  slug text not null unique,
  phase text not null default 'active' check (phase in ('active','capturing','retained','restoring','expired')),
  snapshot_id text,
  resources jsonb not null,
  last_activity_at timestamptz not null default now(),
  phase_updated_at timestamptz not null default now(),
  retry_after timestamptz not null default now(),
  expires_at timestamptz,
  verified_at timestamptz,
  check (phase not in ('retained','restoring') or (snapshot_id is not null and expires_at is not null and verified_at is not null))
);
alter table public.workspace_retention enable row level security;
revoke all on public.workspace_retention from anon, authenticated;
create index workspace_retention_idle on public.workspace_retention(last_activity_at) where phase='active';

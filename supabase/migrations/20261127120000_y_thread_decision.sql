-- Y²'s keep-or-archive decisions on settled threads, one row per decision
-- (src/server/adapters/y-settled-facts.ts). Additive; no foreign key on the
-- session so the log outlives a thread's deletion. Facts hold numbers and
-- enums only, never transcript text.
create table if not exists y_thread_decision (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid not null references project(id) on delete cascade,
  session_id uuid not null,
  decision text not null check (decision in ('archived','kept','refused')),
  code text not null check (length(code) <= 64),
  reason text not null check (length(reason) <= 300),
  facts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists y_thread_decision_session on y_thread_decision(session_id, created_at desc);
create index if not exists y_thread_decision_project on y_thread_decision(project_id, created_at desc);
alter table y_thread_decision enable row level security;
revoke all on y_thread_decision from public, anon, authenticated;

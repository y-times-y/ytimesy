-- Backoff for the per-minute checkpoint backstop. A capture that keeps failing
-- (oversized workspace, provider error) otherwise restarts its chat VM every
-- minute, so the VM never reaches its idle timeout.
create table public.session_checkpoint_failure (
 session_id uuid primary key references public.agent_session(id) on delete cascade,
 failures integer not null check (failures > 0),
 stage text not null check (stage in ('wake','export','upload','save','advanced')),
 retry_after timestamptz not null,
 failed_at timestamptz not null default now()
);
alter table public.session_checkpoint_failure enable row level security;
revoke all on public.session_checkpoint_failure from anon, authenticated;

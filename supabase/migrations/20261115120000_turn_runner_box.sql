-- Turn runner boxes (docs/turn-runner-boxes.md): AWS machines that run the
-- model loop of API turns, with the chat's Durable Object only coordinating.
--
-- A box registers itself here every few seconds. A turn is routed to the
-- boxes (executor 'node') only while one has been seen lately; otherwise it
-- runs in its chat's Durable Object as before.
set local lock_timeout = '5s';

create table if not exists public.turn_runner_box (
  id text primary key,
  last_seen_at timestamptz not null default now(),
  capacity integer not null check (capacity between 1 and 64),
  running integer not null default 0 check (running >= 0),
  version text
);
alter table public.turn_runner_box enable row level security;
revoke all on public.turn_runner_box from anon, authenticated;

-- How many times a box lost the turn mid-run and another took it over.
alter table public.api_turn add column if not exists run_attempts integer not null default 0;

-- A turn runner box's identity can be revoked (docs/turn-runner-boxes.md): the
-- edge refuses a revoked box's claims, renewals and model requests, and its
-- running turns are taken over once their lease lapses.
set local lock_timeout = '5s';

alter table public.turn_runner_box add column if not exists revoked_at timestamptz;

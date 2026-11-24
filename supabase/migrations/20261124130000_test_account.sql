-- The one synthetic account agents sign in as to verify a change live
-- (docs/testing-live.md). The flag is the only thing that lets a test
-- session be minted for a user; the partial unique index allows exactly one.
alter table auth_user
  add column if not exists is_test_account boolean not null default false;
create unique index if not exists auth_user_single_test_account
  on auth_user (is_test_account) where is_test_account;

-- Audit and rate limit for test sessions: one row per attempt, with the
-- thread or chat that asked.
create table if not exists test_session_event (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  action text not null check (action in ('minted', 'refused', 'reset')),
  caller text not null check (char_length(caller) <= 120),
  reason text
);
create index if not exists test_session_event_at on test_session_event (at desc);
alter table test_session_event enable row level security;
revoke all on test_session_event from anon, authenticated;

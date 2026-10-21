-- Training-data consent (src/content/legal/training-opt-in.md). Only the
-- consent plumbing: nothing reads these to collect or export data yet.

-- Account-level consent; no row means off (the default for every account).
create table training_consent (
  user_id text primary key references auth_user(id) on delete cascade,
  enabled boolean not null default false,
  policy_version text not null,
  changed_at timestamptz not null default now(),
  source text not null check (source in ('settings','onboarding'))
);
alter table training_consent enable row level security;
revoke all on training_consent from anon, authenticated;

-- Append-only proof of every opt-in and withdrawal. No foreign key on purpose:
-- rows outlive the account as proof of consent and withdrawal.
create table training_consent_event (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  enabled boolean not null,
  policy_version text not null,
  source text not null check (source in ('settings','onboarding','account-deletion')),
  created_at timestamptz not null default now()
);
create index training_consent_event_user on training_consent_event(user_id, created_at);
alter table training_consent_event enable row level security;
revoke all on training_consent_event from anon, authenticated;

-- Append-only: the application may insert, never change or remove, events.
create function training_consent_event_append_only() returns trigger
language plpgsql set search_path=public as $$
begin
  raise exception 'training_consent_event is append-only';
end;
$$;
create trigger training_consent_event_append_only
  before update or delete on training_consent_event
  for each row execute function training_consent_event_append_only();

-- "Never use this project for training": can only exclude, never include.
alter table project add column training_excluded boolean not null default false;

-- Fixed when the turn is queued (consent on and project not excluded); later
-- only ever set to false (withdrawal or project exclusion).
alter table api_turn add column training_eligible boolean not null default false;

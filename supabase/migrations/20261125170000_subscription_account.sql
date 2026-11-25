-- More than one subscription account per provider (several ChatGPT/Codex
-- plans, several Claude plans) owned by the same person. The existing single
-- connection (agent_account for Codex, claude_subscription for Claude) is
-- untouched and stays the "primary" account; this table holds the extra ones,
-- so no sealed token moves and a user with one account behaves exactly as before.
-- Tokens are sealed in the token vault (purpose subscription-account, bound to
-- the user and the account id) and never leave the edge.
create table subscription_account (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  provider text not null check (provider in ('codex', 'claude')),
  label text not null check (char_length(label) between 1 and 60),
  -- Provider's own id for the account (ChatGPT account id, or a hash of the
  -- Claude token): adding the same account twice is refused.
  external_id text not null check (char_length(external_id) <= 200),
  email text check (email is null or char_length(email) <= 320),
  plan_type text check (plan_type is null or char_length(plan_type) <= 60),
  sealed_auth text not null,
  status text not null default 'connected'
    check (status in ('connected', 'expired', 'refused', 'limited')),
  message text check (message is null or char_length(message) <= 300),
  limited_until timestamptz,
  priority integer not null default 100,
  last_used_at timestamptz,
  plan_usage jsonb,
  plan_usage_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index subscription_account_user_provider
  on subscription_account (user_id, provider, priority);
alter table subscription_account enable row level security;
revoke all on subscription_account from anon, authenticated;

-- The account a chat is pinned to ('primary' or an account id); null is Auto.
alter table agent_session add column subscription_pin text
  check (subscription_pin is null or char_length(subscription_pin) <= 64);

-- The primary (existing) accounts take part in naming, ordering and rotation.
-- Additive only: defaults keep every current row behaving as before.
alter table agent_account
  add column label text check (label is null or char_length(label) between 1 and 60),
  add column priority integer not null default 0,
  add column last_used_at timestamptz,
  add column limited_until timestamptz;
alter table claude_subscription
  add column label text check (label is null or char_length(label) between 1 and 60),
  add column priority integer not null default 0,
  add column last_used_at timestamptz;

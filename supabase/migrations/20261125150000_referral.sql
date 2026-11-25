-- Referral: a personal code per account, who joined through whose code, and the
-- ledger of rewards. Server-only data (no Data API access). Additive.
--
-- A reward is a restart of the account's current usage windows. The unique
-- constraints make a double grant impossible even when two workers decide the
-- same referral at once: one reward per referred account and role.

create table referral_code (
  user_id text primary key references auth_user(id) on delete cascade,
  code text not null unique check (code ~ '^r-[a-z0-9]{8}$'),
  created_at timestamptz not null default now()
);

create table referral (
  referred_user_id text primary key references auth_user(id) on delete cascade,
  referrer_user_id text not null references auth_user(id) on delete cascade,
  code text not null check (code ~ '^r-[a-z0-9]{8}$'),
  -- attributed: signed up through a code; pending: qualified, waiting out the delay;
  -- granted: rewarded; held: kept for review (not rewarded); blocked: refused.
  status text not null default 'attributed'
    check (status in ('attributed', 'pending', 'granted', 'held', 'blocked')),
  reason text check (char_length(reason) <= 80),
  -- Salted hashes only: the normalised sign-up address and the sign-up network.
  email_key text check (char_length(email_key) <= 64),
  network_key text check (char_length(network_key) <= 64),
  attributed_at timestamptz not null default now(),
  qualified_at timestamptz,
  grant_after timestamptz,
  decided_at timestamptz,
  check (referred_user_id <> referrer_user_id)
);
create index referral_referrer on referral(referrer_user_id, status);
create index referral_email_key on referral(email_key) where email_key is not null;
create index referral_network_key on referral(network_key, attributed_at) where network_key is not null;
create index referral_open on referral(status, grant_after) where status in ('attributed', 'pending');

create table referral_reward (
  id uuid primary key default gen_random_uuid(),
  referred_user_id text not null references referral(referred_user_id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  role text not null check (role in ('referred', 'referrer')),
  granted_at timestamptz not null default now(),
  -- Null until the reset has been applied: it applies when the account is next held back.
  redeemed_at timestamptz,
  unique (referred_user_id, role),
  check ((role = 'referred') = (user_id = referred_user_id))
);
create index referral_reward_referrer on referral_reward(user_id, granted_at) where role = 'referrer';

create index referral_reward_unredeemed on referral_reward(user_id) where redeemed_at is null;

-- The kill switch: one row an operator sets. Off means no new attribution, no
-- grants and no prompts; pending referrals are kept.
create table referral_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into referral_config default values on conflict do nothing;

alter table referral_code enable row level security;
alter table referral enable row level security;
alter table referral_reward enable row level security;
alter table referral_config enable row level security;
revoke all on referral_code, referral, referral_reward, referral_config from anon, authenticated;

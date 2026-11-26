-- Several Grok (xAI plan) accounts per user, the same way as Codex and Claude:
-- the one model_connection row of kind 'xai-subscription' stays the *slot* (its
-- id is what chat routes point at), and the other accounts wait in
-- subscription_account. Switching moves an account's whole state into the slot
-- under the row lock xAI's token refresh already takes. Additive only.
alter table subscription_account drop constraint subscription_account_provider_check;
alter table subscription_account add constraint subscription_account_provider_check
  check (provider in ('codex', 'claude', 'grok'));

alter table model_connection
  add column account_id uuid not null default gen_random_uuid(),
  add column account_label text check (account_label is null or char_length(account_label) between 1 and 60),
  add column priority integer not null default 0,
  add column last_used_at timestamptz,
  add column limited_until timestamptz,
  add column activated_at timestamptz not null default now();

-- SuperGrok subscription: a user's xAI plan, signed in with xAI's device-code
-- OAuth, is a model connection like an API key. Its sealed credential holds
-- the OAuth tokens (purpose 'xai-subscription') instead of a key; chats call
-- api.x.ai with the user's bearer token. Behind YTIMESY_XAI_SUBSCRIPTION_ENABLED.
alter table model_connection
  add column kind text not null default 'key'
    check (kind in ('key', 'xai-subscription'));

-- 'reconnect': xAI rejected the sign-in; 'not-eligible': xAI refused the plan.
-- Both wait for the user to sign in again. API keys stay 'ready'.
alter table model_connection
  add column status text not null default 'ready'
    check (status in ('ready', 'reconnect', 'not-eligible'));

-- One subscription per user.
create unique index model_connection_one_xai_subscription
  on model_connection(user_id) where kind = 'xai-subscription';

-- A device-code sign-in the web server is waiting on (sealed device code and
-- user code, purpose 'xai-device-login'). Removed when it completes, fails or expires.
create table xai_device_login (
  user_id text primary key references auth_user(id) on delete cascade,
  sealed_login text not null,
  updated_at timestamptz not null default now()
);
alter table xai_device_login enable row level security;
revoke all on xai_device_login from anon, authenticated;

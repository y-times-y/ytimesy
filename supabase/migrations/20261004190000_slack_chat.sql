-- Chat SDK 4.41.1 schema is migration-owned; runtime DDL is disabled.
CREATE TABLE IF NOT EXISTS chat_state_subscriptions (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
  );
CREATE TABLE IF NOT EXISTS chat_state_locks (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
  );
CREATE TABLE IF NOT EXISTS chat_state_cache (
    key_prefix text NOT NULL,
    cache_key text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, cache_key)
  );
CREATE INDEX IF NOT EXISTS chat_state_locks_expires_idx
    ON chat_state_locks (expires_at);
CREATE INDEX IF NOT EXISTS chat_state_cache_expires_idx
    ON chat_state_cache (expires_at);
CREATE TABLE IF NOT EXISTS chat_state_lists (
    key_prefix text NOT NULL,
    list_key text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamptz,
    PRIMARY KEY (key_prefix, list_key, seq)
  );
CREATE INDEX IF NOT EXISTS chat_state_lists_expires_idx
    ON chat_state_lists (expires_at);
CREATE TABLE IF NOT EXISTS chat_state_queues (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (key_prefix, thread_id, seq)
  );
CREATE INDEX IF NOT EXISTS chat_state_queues_expires_idx
    ON chat_state_queues (expires_at);
alter table public.chat_state_subscriptions enable row level security;
revoke all on public.chat_state_subscriptions from anon, authenticated;
alter table public.chat_state_locks enable row level security;
revoke all on public.chat_state_locks from anon, authenticated;
alter table public.chat_state_cache enable row level security;
revoke all on public.chat_state_cache from anon, authenticated;
alter table public.chat_state_lists enable row level security;
revoke all on public.chat_state_lists from anon, authenticated;
alter table public.chat_state_queues enable row level security;
revoke all on public.chat_state_queues from anon, authenticated;

create table public.slack_thread (
	installation_id text not null,
	thread_id text not null,
	slack_user_id text not null,
	user_id text not null references public.auth_user(id) on delete cascade,
	session_id uuid not null references public.agent_session(id) on delete cascade,
	primary key (installation_id, thread_id)
);
create table public.slack_link_request (
	token_hash text primary key,
	installation_id text not null,
	thread_id text not null,
	slack_user_id text not null,
	expires_at timestamptz not null
);
create table public.slack_message_receipt (
	installation_id text not null,
	thread_id text not null,
	message_id text not null,
	session_id uuid references public.agent_session(id) on delete cascade,
	state text not null default 'received' check (state in ('received','dispatching','submitted','done')),
	created_at timestamptz not null default now(),
	primary key (installation_id, thread_id, message_id)
);
alter table public.slack_thread enable row level security;
alter table public.slack_link_request enable row level security;
alter table public.slack_message_receipt enable row level security;
revoke all on public.slack_thread, public.slack_link_request, public.slack_message_receipt from anon, authenticated;
create index slack_pending_responses on public.slack_message_receipt(created_at) where state='submitted';

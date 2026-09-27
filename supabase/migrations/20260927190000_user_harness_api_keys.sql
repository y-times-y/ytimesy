create table user_harness_api_key (
  user_id text not null references auth_user(id) on delete cascade,
  provider text not null check (provider in ('codex', 'claude')),
  encrypted_key text not null,
  hint text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table user_harness_api_key enable row level security;
revoke all on user_harness_api_key from anon, authenticated;

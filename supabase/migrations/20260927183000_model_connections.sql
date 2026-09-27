create table model_connection (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  provider text not null check (provider in ('openai','anthropic','google','openrouter','compatible')),
  label text not null check (length(label) between 1 and 80),
  base_url text not null,
  sealed_credential text not null,
  models jsonb not null default '[]'::jsonb check (jsonb_typeof(models) = 'array'),
  revision uuid not null,
  last_probe_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index model_connection_owner on model_connection(user_id);
alter table model_connection enable row level security;
revoke all on model_connection from anon, authenticated;

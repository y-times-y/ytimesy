-- Secrets the user chose to share with every project they own. A project's own
-- secret of the same name wins. Values stay encrypted at rest.
create table account_secret (
 id uuid primary key,
 user_id text not null references auth_user(id) on delete cascade,
 name text not null,
 hint text not null,
 encrypted_iv text not null,
 encrypted_tag text not null,
 encrypted_ciphertext text not null,
 encrypted_version smallint not null default 1,
 kind text not null default 'runtime' check (kind in ('environment', 'runtime')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id, name)
);
alter table account_secret enable row level security;
revoke all on account_secret from anon, authenticated;

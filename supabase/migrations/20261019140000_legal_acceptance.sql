-- Which Terms of Service and Privacy Policy versions each user accepted, and
-- when (src/server/adapters/legal-acceptance.ts). Written when an account is
-- created (every sign-up and sign-in path shows the consent) and again when a
-- signed-in user accepts a newer version. No row, or an older version than
-- src/content/legal/versions.ts, means the app asks the user to accept.
create table legal_acceptance (
  user_id text primary key references auth_user(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now(),
  source text not null check (source in ('signup','prompt'))
);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table legal_acceptance enable row level security;
revoke all on legal_acceptance from anon, authenticated;

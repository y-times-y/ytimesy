-- Where each account first came from (src/domain/referral-attribution.ts):
-- the first-touch ref/utm_* values, the referring host and the landing path,
-- copied from the yt_first_touch cookie when the account is created (email,
-- GitHub or Google sign-up). One row per user, written once and never
-- overwritten. Deleted with the account.
create table user_attribution (
  user_id text primary key references auth_user(id) on delete cascade,
  ref text check (ref ~ '^[a-z0-9_-]{1,32}$'),
  utm_source text check (char_length(utm_source) <= 64),
  utm_medium text check (char_length(utm_medium) <= 64),
  utm_campaign text check (char_length(utm_campaign) <= 64),
  utm_content text check (char_length(utm_content) <= 64),
  utm_term text check (char_length(utm_term) <= 64),
  referrer_host text check (char_length(referrer_host) <= 100),
  landing_path text check (char_length(landing_path) <= 120),
  first_seen_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Sign-ups per platform: select ref, count(*) from user_attribution group by 1.
create index user_attribution_ref_idx on user_attribution (ref);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table user_attribution enable row level security;
revoke all on user_attribution from anon, authenticated;

-- Operational alerts emailed to the owner (src/server/adapters/owner-alerts.ts):
-- one row per alert kind and dedupe key, so a recurring condition emails at
-- most once per key (callers put an hour or month bucket in the key).
create table owner_alert (
  kind text not null check (kind in ('fleet-budget','abandoned-turns','cron-failure','email-failed')),
  dedupe_key text not null check (length(dedupe_key) <= 200),
  subject text not null check (length(subject) <= 200),
  created_at timestamptz not null default now(),
  primary key (kind, dedupe_key)
);
create index owner_alert_created on owner_alert(created_at);

-- Server-only data: never exposed through the Data API.
alter table owner_alert enable row level security;
revoke all on owner_alert from anon, authenticated;

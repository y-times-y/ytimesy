-- A chat whose VM keeps failing to wake emails the owner before a user has
-- to report it. machine_wake_failure counts consecutive refusals per VM (a
-- successful wake deletes the row); the third within an hour alerts once.
alter table owner_alert drop constraint owner_alert_kind_check;
alter table owner_alert add constraint owner_alert_kind_check
  check (kind in ('fleet-budget','abandoned-turns','cron-failure','email-failed','codex-egress','chat-wake-failed'));

create table machine_wake_failure (
  vm_id text primary key check (length(vm_id) <= 200),
  failures integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  last_detail text check (length(last_detail) <= 300)
);
alter table machine_wake_failure enable row level security;

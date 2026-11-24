-- Y² is on by default for everyone (docs/y.md, "On by default").
--
-- Additive and idempotent; nothing here rewrites or locks a large table.
--
-- project.y_choice records what the person chose: null = never chose (the
-- default applies), 'on' / 'off' = they switched it. y_enabled alone could not
-- tell "never set" from "turned off", so a backfill would have switched
-- deliberate opt-outs back on. New writes set it; the backfill
-- (scripts/backfill-y-default-on.ts) fills it for older rows first.
alter table project
  add column if not exists y_choice text check (y_choice in ('on','off'));

-- A column default is a catalog change, not a table rewrite.
alter table project alter column y_enabled set default true;

-- The user-level switch: "Y² for my projects" (default on). Off turns Y² off
-- for the user's projects and for the ones they add later.
create table if not exists user_y_setting (
  user_id text primary key references auth_user(id) on delete cascade,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table user_y_setting enable row level security;
revoke all on user_y_setting from anon, authenticated;

-- Wakes sent to a user's Y² chats per day, across projects (the per-project
-- caps live in each project's crew): one row per user per day.
create table if not exists y_wake_day (
  user_id text not null references auth_user(id) on delete cascade,
  day date not null,
  wakes integer not null default 0,
  primary key (user_id, day)
);
alter table y_wake_day enable row level security;
revoke all on y_wake_day from anon, authenticated;

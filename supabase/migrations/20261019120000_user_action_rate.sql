-- Per-user fixed-window counters for abuse limits on chat sends, project
-- creation and VM creation (src/server/adapters/user-action-rate.ts). One row
-- per user, action and window; rows older than a day are pruned on write.
create table user_action_rate (
  user_id text not null references auth_user(id) on delete cascade,
  action text not null check (action in ('chat-send','project-create','vm-create')),
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (user_id, action, window_start)
);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table user_action_rate enable row level security;
revoke all on user_action_rate from anon, authenticated;

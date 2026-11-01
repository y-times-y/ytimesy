-- When an account left the first-run steps (Continue on the last one), so a
-- new account with no project yet opens the workspace on every browser.
create table if not exists user_first_run (
	user_id text primary key references auth_user(id) on delete cascade,
	finished_at timestamptz not null default now()
);

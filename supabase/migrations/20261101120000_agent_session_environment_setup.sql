-- A chat started from "Set up environment": its turns never commit or push
-- to GitHub (setup commands can regenerate tracked files).
alter table public.agent_session
  add column environment_setup boolean not null default false;

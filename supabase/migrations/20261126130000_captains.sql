-- Captains (docs/captains.md): additional Super agents of a project, each a
-- Y²-like chat with a name, a colour, an optional label (group) and role
-- instructions. Y² stays the project's leader and is not a row here.
--
-- A captain is data plus one chat (agent_session.chat_role = 'captain'): no
-- machine, no Durable Object and no timer of its own; it runs only when a
-- message, an @mention or a wake reaches its chat. Additive: existing rows and
-- the Y² chat behave as before.

-- 'captain' joins 'y2' (and the interruption canary's 'canary', which another
-- change added in production as 20261126120000) as a chat role. The existing
-- check is looked up and replaced, keeping every role it allowed.
do $$
declare existing text;
begin
  select conname into existing
  from pg_constraint
  where conrelid = 'agent_session'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%chat_role%'
    and pg_get_constraintdef(oid) not like '%parent_session_id%';
  if existing is not null then
    execute format('alter table agent_session drop constraint %I', existing);
  end if;
  alter table agent_session
    add constraint agent_session_chat_role_check
    check (chat_role is null or chat_role in ('y2', 'canary', 'captain'));
end $$;

create table captain (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid not null references project(id) on delete cascade,
  -- The captain's own chat; the captain goes with it.
  chat_id uuid not null references agent_session(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  label text check (label is null or char_length(label) between 1 and 24),
  color text not null check (color ~ '^#[0-9a-f]{6}$'),
  role_prompt text not null default '' check (char_length(role_prompt) <= 4000),
  position integer not null default 0,
  -- The first line of its last answer and when: set when its turn settles, so
  -- the sidebar never reads a transcript.
  last_line text check (last_line is null or char_length(last_line) <= 200),
  last_at timestamptz,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index captain_chat on captain (chat_id);
-- A name is unique within a project while the captain is live, by its @handle:
-- lower case, spaces as dashes (src/domain/captain.ts captainHandle).
create unique index captain_live_name on captain (project_id, lower(replace(name, ' ', '-')))
  where archived_at is null;
create index captain_project on captain (project_id, position) where archived_at is null;
alter table captain enable row level security;
revoke all on captain from anon, authenticated;

-- A display name for the leader (Y²), shown as "otto" in the design; null keeps "Super agent".
alter table project add column leader_name text
  check (leader_name is null or char_length(leader_name) between 1 and 40);

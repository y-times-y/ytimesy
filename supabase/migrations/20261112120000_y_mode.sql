-- Y (src/domain/y-agent.ts, src/domain/y-squared.ts): a project whose chats are
-- Y, with one Y² chat pinned above its threads.
alter table project add column y_enabled boolean not null default false;

-- 'y2' marks a project's Y² chat; null is an ordinary thread or a subagent.
alter table agent_session
  add column chat_role text check (chat_role = 'y2'),
  add constraint agent_session_y2_is_root
    check (chat_role is null or parent_session_id is null);

-- One live Y² chat per project.
create unique index agent_session_one_y2
  on agent_session(user_id, project_id)
  where chat_role = 'y2' and archived_at is null;

-- The interruption canary's chat is internal: chat_role 'canary' hides it from
-- the owner's thread list, stats and crew, keeps its machine out of cleanup, and
-- makes it writable only by the canary (src/server/adapters/canary-chat.ts).
-- Additive: the check constraint on chat_role (y2 only until now) also allows it.
alter table agent_session drop constraint if exists agent_session_chat_role_check;
alter table agent_session
  add constraint agent_session_chat_role_check check (chat_role in ('y2', 'canary'));

-- The chat(s) the canary already made. It has no thread number (not a thread).
update agent_session
   set chat_role = 'canary', thread_number = null
 where chat_role is null and parent_session_id is null
   and id::text in (select session_id from canary_run where session_id is not null);

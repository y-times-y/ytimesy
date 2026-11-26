-- Captains were removed from the product (docs/captains-removal.md). The code
-- stopped using them first; this drops their data. The one captain in
-- production belonged to the test account.

-- The captains' chats and what hangs off them (turns first: not every table
-- that names a chat cascades).
delete from api_turn
 where session_id in (select id from agent_session where chat_role = 'captain');
delete from agent_session where chat_role = 'captain';

drop table if exists captain;
alter table project drop column if exists leader_name;

-- chat_role goes back to the roles that exist (Y², the interruption canary).
alter table agent_session drop constraint if exists agent_session_chat_role_check;
alter table agent_session
  add constraint agent_session_chat_role_check check (chat_role in ('y2', 'canary'));

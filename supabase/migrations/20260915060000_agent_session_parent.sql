-- A side-chat agent is a child session with its own VM copy.
-- Root chats stay in the sidebar; children do not share a checkout.

alter table agent_session
 add column parent_session_id uuid references agent_session(id) on delete cascade;

create index agent_session_parent on agent_session(parent_session_id);

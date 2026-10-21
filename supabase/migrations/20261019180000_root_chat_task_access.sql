-- Root chats publish as chats (commit, push their own ytimesy/ branch, keep a
-- draft PR open); task_access only describes child tasks now. Clear the old
-- 'read_only' label new root chats used to get, so nothing reads it as a role.
update agent_session
set task_access = null
where parent_session_id is null
  and task_access = 'read_only';

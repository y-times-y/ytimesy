-- agent_task_event.child_session_id is a foreign key with no index: the
-- anti-join in recoverChildTurnEvents and the cascade delete of a chat both
-- scanned the table for it.
set local lock_timeout = '5s';

create index agent_task_event_child on public.agent_task_event(child_session_id);

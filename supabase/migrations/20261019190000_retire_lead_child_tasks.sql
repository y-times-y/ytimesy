-- Retire the lead/child task architecture (docs/recursive-task-architecture.md).
-- Only root chats and builder subagents (agent_role set) remain.
--
-- 1. Rows of retired children: a child session without a subagent role (old
--    lead/child tasks and retired side chats), with everything under it
--    (parent_session_id cascades). Row-only: no VM or stored object is
--    touched here. A shared child ran on its parent's VM, which stays with
--    the parent. A fresh child's own VM loses its workspace_retention row
--    (cascade), so destroy those VMs before applying if they still exist.
delete from agent_session
where parent_session_id is not null
  and agent_role is null;

-- 2. Columns and tables nothing reads any more. Kept: task_prompt,
--    task_state, task_summary, task_placement, task_access (subagents still
--    write them), task_review_state (task patch evidence, recovery) and
--    task_branch (chat fork branch fallback).
drop index if exists agent_session_task_dependency;
drop index if exists agent_session_candidate_position;
drop index if exists agent_session_competition;
alter table agent_session
  drop column if exists depends_on_session_id,
  drop column if exists task_execution,
  drop column if exists task_pull_request_url,
  drop column if exists candidate_index,
  drop column if exists competition_id;
drop table if exists agent_competition;
drop table if exists fusion_sidekick;
drop table if exists agent_pr_repair_event;
drop table if exists agent_pr_repair_control;

alter table agent_session
 add column task_prompt text,
 add column task_state text check (
  task_state in ('draft','working','waiting','idle','done','failed')
 ),
 add column task_placement text check (
  task_placement in ('shared','fresh')
 ),
 add column task_access text check (
  task_access in ('read_only','read_write')
 ),
 add column task_execution text check (
  task_execution in ('parallel','stacked')
 ),
 add column depends_on_session_id uuid references agent_session(id) on delete set null,
 add column task_summary text,
 add column task_review_state text check (
  task_review_state in ('pending','reviewed','rejected')
 );

update agent_session
set task_prompt = '',
    task_state = case turn_status
      when 'running' then 'working'
      when 'completed' then 'done'
      when 'failed' then 'failed'
      else 'idle'
    end,
    task_placement = 'fresh',
    task_access = 'read_write',
    task_execution = 'parallel',
    task_review_state = 'pending'
where parent_session_id is not null
  and title <> 'Side chat';

create index agent_session_task_dependency
 on agent_session(depends_on_session_id)
 where depends_on_session_id is not null;

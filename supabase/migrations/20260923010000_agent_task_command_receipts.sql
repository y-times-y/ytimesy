create table agent_task_command_receipt (
 parent_session_id uuid not null references agent_session(id) on delete cascade,
 request_id text not null,
 status text not null check (status in ('processing', 'done')),
 response jsonb,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 primary key (parent_session_id, request_id),
 constraint agent_task_command_receipt_response_check check (
  (status = 'processing' and response is null) or
  (status = 'done' and response is not null)
 )
);

create index agent_task_command_receipt_processing
 on agent_task_command_receipt(created_at)
 where status = 'processing';

alter table agent_task_command_receipt enable row level security;
revoke all on agent_task_command_receipt from public, anon, authenticated;

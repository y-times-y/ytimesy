alter table agent_task_command_receipt
add column updated_at timestamptz not null default now();

update agent_task_command_receipt
set updated_at = created_at;

drop index agent_task_command_receipt_processing;
create index agent_task_command_receipt_processing
 on agent_task_command_receipt(updated_at)
 where status = 'processing';

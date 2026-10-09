-- Builders may use 128 model steps; step 129 records bounded termination.
alter table public.model_workflow_step
  drop constraint model_workflow_step_step_index_check,
  add constraint model_workflow_step_step_index_check
    check(step_index between 1 and 129);

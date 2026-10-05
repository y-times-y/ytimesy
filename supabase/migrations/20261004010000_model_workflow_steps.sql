create table public.model_workflow_step (
  turn_id uuid not null references public.api_turn(id) on delete cascade,
  lease_id uuid not null,
  step_index integer not null check(step_index between 1 and 31),
  state text not null check(state in ('processing','done')),
  outcome text check(outcome in ('continue','completed','failed','cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(turn_id,lease_id,step_index),
  check((state='processing' and outcome is null and completed_at is null)
    or (state='done' and outcome is not null and completed_at is not null))
);
alter table public.model_workflow_step enable row level security;
revoke all on public.model_workflow_step from anon, authenticated;

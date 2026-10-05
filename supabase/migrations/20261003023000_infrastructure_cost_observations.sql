create table public.infrastructure_fleet_observation (
  singleton boolean primary key default true check(singleton),
  observed_at timestamptz not null,
  projection jsonb not null check(jsonb_typeof(projection)='object')
);
alter table public.infrastructure_fleet_observation enable row level security;
revoke all on public.infrastructure_fleet_observation from anon,authenticated;

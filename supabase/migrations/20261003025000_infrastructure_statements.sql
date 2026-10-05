create table public.infrastructure_provider_statement (
  provider text not null check(provider='freestyle'),
  account_id text not null,
  source_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null check(period_end>period_start),
  statement jsonb not null check(jsonb_typeof(statement)='object'),
  imported_by text not null references public.auth_user(id),
  imported_at timestamptz not null default now(),
  primary key(provider,account_id,source_id)
);
create index infrastructure_statement_period on public.infrastructure_provider_statement(provider,account_id,period_start,period_end);
alter table public.infrastructure_provider_statement enable row level security;
revoke all on public.infrastructure_provider_statement from anon,authenticated;

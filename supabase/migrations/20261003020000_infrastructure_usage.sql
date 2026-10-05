-- Infrastructure allowances are independent of model-provider billing.
create table public.infrastructure_usage_policy (
 user_id text primary key references public.auth_user(id) on delete cascade,
 monthly_micro_usd bigint not null check (monthly_micro_usd between 0 and 1000000000000)
);

create table public.infrastructure_usage_adjustment (
 id uuid primary key,
 actor_id text not null,
 user_id text not null,
 kind text not null check (kind in ('monthly_limit','grant')),
 period date not null check (extract(day from period)=1),
 amount_micro_usd bigint not null check (amount_micro_usd between 0 and 1000000000000),
 reason text not null check (length(trim(reason)) between 1 and 500),
 created_at timestamptz not null default now()
);
create index infrastructure_usage_adjustment_user_period
 on public.infrastructure_usage_adjustment(user_id,period);

create table public.infrastructure_usage_reservation (
 id uuid primary key,
 user_id text not null,
 resource_key text not null check (length(resource_key) between 1 and 200),
 period date not null check (extract(day from period)=1),
 reserved_micro_usd bigint not null check (reserved_micro_usd between 1 and 1000000000000),
 consumed_micro_usd bigint check (consumed_micro_usd between 0 and reserved_micro_usd),
 created_at timestamptz not null default now(),
 settled_at timestamptz,
 check ((consumed_micro_usd is null) = (settled_at is null))
);
create index infrastructure_usage_reservation_user_period
 on public.infrastructure_usage_reservation(user_id,period);
create index infrastructure_usage_reservation_period
 on public.infrastructure_usage_reservation(period);

alter table public.infrastructure_usage_policy enable row level security;
alter table public.infrastructure_usage_adjustment enable row level security;
alter table public.infrastructure_usage_reservation enable row level security;
revoke all on public.infrastructure_usage_policy from anon, authenticated;
revoke all on public.infrastructure_usage_adjustment from anon, authenticated;
revoke all on public.infrastructure_usage_reservation from anon, authenticated;
-- An admission survives crashes between reservation and the provider create/update.
create table infrastructure_vm_admission (
 slug text primary key,
 user_id text not null references auth_user(id),
 reservation_id uuid not null references infrastructure_usage_reservation(id),
 max_run_total_seconds bigint not null check(max_run_total_seconds > 0),
 baseline_seconds bigint not null check(baseline_seconds >= 0),
 hourly_micro_usd bigint not null check(hourly_micro_usd > 0),
 updated_at timestamptz not null default now()
);
alter table infrastructure_vm_admission enable row level security;
revoke all on infrastructure_vm_admission from anon, authenticated;

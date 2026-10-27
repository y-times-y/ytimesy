-- Running fleet totals of infrastructure_usage_reservation, so a budget
-- admission reads a few rows instead of summing every reservation ever made.
-- Per UTC month (period):
--   charged_micro_usd = sum(coalesce(consumed, reserved)) of its reservations
--   open_micro_usd    = sum(reserved) of its reservations not yet settled
-- The fleet month (src/server/adapters/infrastructure-usage.ts) is
-- charged[P] + open of every other period (holds survive month boundaries);
-- lifetime is sum(charged). A row trigger keeps both in the same transaction
-- as each insert, settle, release or delete; the upsert's row lock makes
-- concurrent changes add up exactly. Per-user rolling windows are unchanged
-- (they read the user's last week of rows by index).
create table public.infrastructure_usage_total (
 period date primary key,
 charged_micro_usd bigint not null default 0,
 open_micro_usd bigint not null default 0
);
alter table public.infrastructure_usage_total enable row level security;
revoke all on public.infrastructure_usage_total from anon, authenticated;

create function public.infrastructure_usage_total_sync() returns trigger
 language plpgsql as $$
begin
 if tg_op in ('UPDATE', 'DELETE') then
  insert into public.infrastructure_usage_total as t(period, charged_micro_usd, open_micro_usd)
  values (old.period, -coalesce(old.consumed_micro_usd, old.reserved_micro_usd),
   -case when old.consumed_micro_usd is null then old.reserved_micro_usd else 0 end)
  on conflict (period) do update
   set charged_micro_usd = t.charged_micro_usd + excluded.charged_micro_usd,
       open_micro_usd = t.open_micro_usd + excluded.open_micro_usd;
 end if;
 if tg_op in ('INSERT', 'UPDATE') then
  insert into public.infrastructure_usage_total as t(period, charged_micro_usd, open_micro_usd)
  values (new.period, coalesce(new.consumed_micro_usd, new.reserved_micro_usd),
   case when new.consumed_micro_usd is null then new.reserved_micro_usd else 0 end)
  on conflict (period) do update
   set charged_micro_usd = t.charged_micro_usd + excluded.charged_micro_usd,
       open_micro_usd = t.open_micro_usd + excluded.open_micro_usd;
 end if;
 return null;
end $$;

create trigger infrastructure_usage_total_sync
 after insert or update or delete on public.infrastructure_usage_reservation
 for each row execute function public.infrastructure_usage_total_sync();

create function public.infrastructure_usage_total_reset() returns trigger
 language plpgsql as $$
begin
 delete from public.infrastructure_usage_total;
 return null;
end $$;

create trigger infrastructure_usage_total_reset
 after truncate on public.infrastructure_usage_reservation
 for each statement execute function public.infrastructure_usage_total_reset();

-- Backfill under a write lock, committed together with the triggers.
lock table public.infrastructure_usage_reservation in share row exclusive mode;
insert into public.infrastructure_usage_total(period, charged_micro_usd, open_micro_usd)
select period,
 sum(coalesce(consumed_micro_usd, reserved_micro_usd)),
 coalesce(sum(reserved_micro_usd) filter (where consumed_micro_usd is null), 0)
from public.infrastructure_usage_reservation
group by period;

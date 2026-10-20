-- Per-user VM usage is limited over a rolling 5-hour and a rolling 7-day
-- window (src/domain/infrastructure-usage.ts) instead of a calendar month.
-- The deployment sets both limits (YTIMESY_USER_5H_MICRO_USD,
-- YTIMESY_USER_WEEKLY_MICRO_USD); a policy row overrides either for one
-- user. monthly_micro_usd and 'grant'/'monthly_limit' adjustments are kept
-- as history and no longer enforced. Fleet monthly and lifetime caps are
-- unchanged.
alter table public.infrastructure_usage_policy
 alter column monthly_micro_usd drop not null,
 add column five_hour_micro_usd bigint check (five_hour_micro_usd between 0 and 1000000000000),
 add column weekly_micro_usd bigint check (weekly_micro_usd between 0 and 1000000000000);

alter table public.infrastructure_usage_adjustment
 drop constraint infrastructure_usage_adjustment_kind_check,
 add constraint infrastructure_usage_adjustment_kind_check
  check (kind in ('monthly_limit','grant','five_hour_limit','weekly_limit'));

-- Window reads: a user's open holds and recent settlements.
create index infrastructure_usage_reservation_user_settled
 on public.infrastructure_usage_reservation(user_id,settled_at);

-- Auto-reset usage policy (src/server/adapters/infrastructure-usage.ts): a
-- user with auto_reset is metered, warned and shown usage exactly like
-- everyone else, but when new work or a running machine would be refused
-- because one of their own usage windows is exhausted (or its hard ceiling
-- reached), that window restarts now instead, the reset is audited as a
-- 'window_reset' adjustment, and the work goes ahead. Fleet caps still apply.
alter table public.infrastructure_usage_policy
 add column auto_reset boolean not null default false;

-- A window an auto-reset started: carried_micro_usd is what the user's holds
-- open at the reset already counted (machines still running then), so only
-- what those holds add afterwards counts in the new window; waived_until is
-- when the window would have reset for anyone else (null when it had no
-- reset time). Both are cleared when a window starts the ordinary way.
alter table public.infrastructure_usage_window
 add column carried_micro_usd bigint check (carried_micro_usd between 0 and 1000000000000),
 add column waived_until timestamptz;

alter table public.infrastructure_usage_adjustment
 drop constraint infrastructure_usage_adjustment_kind_check,
 add constraint infrastructure_usage_adjustment_kind_check
  check (kind in ('monthly_limit','grant','five_hour_limit','weekly_limit','window_reset'));

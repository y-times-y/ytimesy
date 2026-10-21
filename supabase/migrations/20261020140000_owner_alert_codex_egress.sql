-- Owner alerts for Codex subscription egress (src/domain/owner-alerts.ts):
-- a path became blocked, or every path failed.
alter table owner_alert drop constraint owner_alert_kind_check;
alter table owner_alert add constraint owner_alert_kind_check
  check (kind in ('fleet-budget','abandoned-turns','cron-failure','email-failed','codex-egress'));

-- The Claude plan's latest usage reading (5h and weekly windows), taken by
-- the edge proxy from Anthropic's anthropic-ratelimit-unified-* response
-- headers, for the model picker. Disconnecting deletes it with the row.
alter table claude_subscription
  add column plan_usage jsonb
    check (plan_usage is null or (jsonb_typeof(plan_usage) = 'object' and pg_column_size(plan_usage) <= 2048)),
  add column plan_usage_at timestamptz;

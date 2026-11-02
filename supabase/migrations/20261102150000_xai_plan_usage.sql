-- The Grok plan's latest usage reading (its weekly window), read from xAI's
-- Grok CLI billing endpoint with the subscription's token, for the model
-- picker and Settings. Only kind='xai-subscription' rows set it;
-- disconnecting deletes it with the row.
alter table model_connection
  add column plan_usage jsonb
    check (plan_usage is null or (jsonb_typeof(plan_usage) = 'object' and pg_column_size(plan_usage) <= 2048)),
  add column plan_usage_at timestamptz;

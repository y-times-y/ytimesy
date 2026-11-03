-- A ready build's template snapshot is deleted from the provider once a newer
-- build replaced it and nothing names it. Records when that happened so the
-- release runs once (the row keeps snapshot_id for checkout-commit lookups).
alter table public.environment_build add column snapshot_released_at timestamptz;

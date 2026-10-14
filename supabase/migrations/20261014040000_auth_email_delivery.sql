-- Delivery state for the sealed auth email outbox. The edge executor's cron
-- (and the web request that queued a message) claims due rows, sends them, and
-- records the outcome; action URLs are blanked once a message is sent or given up.
alter table auth_email_outbox
	add column attempts integer not null default 0,
	add column next_attempt_at timestamptz not null default now(),
	add column sent_at timestamptz,
	add column failed_at timestamptz,
	add column last_error text;

create index auth_email_outbox_due on auth_email_outbox(next_attempt_at)
	where sent_at is null and failed_at is null;

-- Server-only verification mail queue. Tokens stay encrypted; Data API roles
-- cannot read this table. A mail provider can replace the adapter later.
create table auth_email_outbox (
	id bigint generated always as identity primary key,
	to_address text not null,
	subject text not null,
	purpose text not null check (purpose = 'verify-email'),
	encrypted_action_url text not null,
	created_at timestamptz not null default now()
);
create index auth_email_outbox_created on auth_email_outbox(created_at desc);

alter table auth_email_outbox enable row level security;
revoke all on auth_email_outbox from anon, authenticated;

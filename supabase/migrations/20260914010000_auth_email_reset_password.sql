-- Password-reset mail uses the same sealed outbox as email verification.
alter table auth_email_outbox
	drop constraint auth_email_outbox_purpose_check,
	add constraint auth_email_outbox_purpose_check
		check (purpose in ('verify-email', 'reset-password'));

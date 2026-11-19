-- "You already have an account": sent when someone signs up with an address
-- that is already registered (src/server/auth/auth.ts, onExistingUserSignUp).
-- It uses the same sealed outbox as the verification and reset messages.
set local lock_timeout = '5s';

alter table auth_email_outbox
	drop constraint auth_email_outbox_purpose_check,
	add constraint auth_email_outbox_purpose_check
		check (purpose in ('verify-email', 'reset-password', 'account-exists'));

-- Terms acceptance moved from a checkbox and a blocking dialog to the
-- "By continuing, you agree" line on sign-in and sign-up plus a dismissible
-- "We updated our Terms" notice. New sources: 'signin' (a sign-in recorded
-- the current versions) and 'notice' (a signed-in user dismissed the notice).
-- 'prompt' stays for rows written by the retired dialog.
alter table legal_acceptance drop constraint legal_acceptance_source_check;
alter table legal_acceptance add constraint legal_acceptance_source_check
  check (source in ('signup','signin','notice','prompt'));

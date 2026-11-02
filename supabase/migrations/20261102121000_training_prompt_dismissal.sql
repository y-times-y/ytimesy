-- The "Help improve ytimesy" card is shown once to accounts that never set
-- training consent (src/features/workspace/training-consent-prompt.tsx).
-- Continuing records consent in training_consent; closing it without
-- continuing records nothing there and lands here, so it is not shown again.
-- Consent stays off (no training_consent row) for those accounts.
create table training_prompt_dismissal (
  user_id text primary key references auth_user(id) on delete cascade,
  dismissed_at timestamptz not null default now()
);
alter table training_prompt_dismissal enable row level security;
revoke all on training_prompt_dismissal from anon, authenticated;

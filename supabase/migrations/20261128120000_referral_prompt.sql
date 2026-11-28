-- When the referral invitation was last shown to an account, so it stays rare:
-- one warm-up, at most one per usage window, quiet for a while after a dismissal.
-- Server-only data (no Data API access). Additive.

create table referral_prompt (
  user_id text primary key references auth_user(id) on delete cascade,
  warmup_shown_at timestamptz,
  last_shown_at timestamptz,
  -- The usage window (id and reset time) the last near-limit invitation was shown for.
  last_window_key text check (char_length(last_window_key) <= 80),
  dismissed_at timestamptz
);

alter table referral_prompt enable row level security;
revoke all on referral_prompt from anon, authenticated;

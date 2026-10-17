-- Development evaluations only (scripts/smoke/eval-user.ts). Each eval run makes
-- a throwaway auth_user so concurrent runs never share per-user state (memory
-- settings and repo, projects, budgets). The app reads this table only when
-- YTIMESY_DEV_EVAL_USERS=1 outside production (src/server/adapters/dev-eval-users.ts);
-- nothing in the product writes it.
--
-- owner_user_id: whose Codex subscription login the eval user borrows. Tokens are
--   read and refreshed on the owner's agent_account row, never copied.
-- harness_variant: per-run harness switches (src/domain/harness-variant.ts).
create table dev_eval_user (
  user_id text primary key references auth_user(id) on delete cascade,
  owner_user_id text not null references auth_user(id) on delete cascade,
  label text not null,
  harness_variant jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (user_id <> owner_user_id)
);
create index dev_eval_user_owner on dev_eval_user(owner_user_id);
alter table dev_eval_user enable row level security;
revoke all on dev_eval_user from anon, authenticated;

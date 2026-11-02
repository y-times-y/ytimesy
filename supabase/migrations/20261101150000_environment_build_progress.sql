-- Environment setup that never blocks a project, shown live.
--
-- environment_build.failure: the failing command, exit code and the last
--   lines of its output (redacted), shown instead of a generic message.
-- environment_build.setup: per repository, where its setup came from
--   (saved, the repository's file, detected, none, plain) and a detected
--   install that failed without failing the build.
-- environment_build_step: one row per build step (machine, clone, install,
--   checks, saving), with a bounded output tail updated while it runs;
--   read by the chat's live "Setting up your project" view.
-- workspace.plain_setup_requested: "Send anyway" after a failed first
--   build; the next build clones only, then clears it.
alter table public.environment_build
  add column failure jsonb,
  add column setup jsonb;

create table public.environment_build_step (
  build_id uuid not null references public.environment_build(id) on delete cascade,
  key text not null check (char_length(key) <= 80),
  label text not null check (char_length(label) <= 200),
  command text check (command is null or char_length(command) <= 2000),
  state text not null check (state in ('running','done','failed','skipped')),
  exit_code integer,
  output text check (output is null or char_length(output) <= 4000),
  note text check (note is null or char_length(note) <= 300),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (build_id, key)
);
alter table public.environment_build_step enable row level security;
revoke all on public.environment_build_step from anon, authenticated;

alter table public.workspace
  add column plain_setup_requested boolean not null default false;

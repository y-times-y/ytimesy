-- The environment template branch is not a chat's branch selection.
alter table public.agent_session
  add column selected_branch text,
  add column base_branch text,
  add column working_branch text;

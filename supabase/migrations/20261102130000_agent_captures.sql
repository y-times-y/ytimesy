-- Agent captures: screenshots and screen recordings the agent makes itself
-- with `ytimesy-browser screenshot|record` during a turn. They are stored like
-- pull request evidence (same R2 prefix, media route, expiry and deletion)
-- and shown inline in the chat; a pull request the chat publishes shows them
-- in its description. Nothing is written into the user's repository.
--
-- source: 'harness' for the pull request captures (unchanged), 'agent' for
--   the agent's own. An agent capture belongs to the chat, not a pull
--   request, so it has no installation, repository, pull request or commit.
-- item_id: the chat item (tool call) the capture was made in, so the chat
--   shows it there; null when it was collected at the end of the turn.
alter table pr_evidence
  add column source text not null default 'harness' check (source in ('harness','agent')),
  add column item_id text check (length(item_id) <= 300),
  alter column installation_id drop not null,
  alter column full_name drop not null,
  alter column pull_number drop not null,
  alter column commit_sha drop not null;

alter table pr_evidence
  add constraint pr_evidence_harness_pull check (
    source = 'agent'
    or (installation_id is not null and full_name is not null and pull_number is not null and commit_sha is not null)
  );

create index pr_evidence_agent_session on pr_evidence(session_id, created_at desc) where source = 'agent';

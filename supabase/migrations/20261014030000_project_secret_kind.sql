-- How a project secret reaches the agent (as in Cursor):
--   environment: an env var the agent can see;
--   runtime: an env var whose value is redacted from everything the agent and
--            the chat see, and blocked from commits;
--   build: passed only to environment setup (install), never to the agent.
-- Existing secrets become runtime secrets, the safest kind the agent can use.
alter table project_secret
  add column kind text not null default 'runtime'
    check (kind in ('environment', 'runtime', 'build'));

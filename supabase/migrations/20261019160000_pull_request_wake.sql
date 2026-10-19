-- Pull requests ytimesy opened for a user's project, and the GitHub events that
-- wake an agent chat for one (src/server/services/pull-request-wake.ts).
--
-- pull_request_link: one row per (project, repository, pull request) that
--   ytimesy created or updated through ensureAppDraftPullRequest. Only these
--   pull requests can start or wake a chat: a comment or failed check on any
--   other pull request is ignored. The pull request description links to
--   /projects/<project>/pulls/<id>/fix ("Fix with ytimesy").
-- origin_session_id: the chat or task whose handoff opened it.
-- session_id: the root chat that GitHub wake-ups continue (set on first wake).
create table pull_request_link (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid not null references project(id) on delete cascade,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  full_name text not null check (length(full_name) <= 200),
  pull_number integer not null check (pull_number > 0),
  head_ref text not null check (length(head_ref) between 1 and 255),
  base_ref text not null check (length(base_ref) between 1 and 255),
  origin_session_id uuid references agent_session(id) on delete set null,
  session_id uuid references agent_session(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, repository_id, pull_number)
);
create index pull_request_link_repository on pull_request_link(repository_id, pull_number);
create index pull_request_link_user on pull_request_link(user_id);

-- One row per wake request. dedupe_key makes GitHub's redeliveries (and the
-- several failed checks of one push) a single wake:
--   ci:<head sha> | comment:<id> | review_comment:<id> | fix:<request id>
-- kind 'ci' waits a short while (available_at) so sibling checks finish.
create table pull_request_wake (
  link_id uuid not null references pull_request_link(id) on delete cascade,
  dedupe_key text not null check (length(dedupe_key) <= 120),
  delivery_id text not null check (length(delivery_id) <= 80),
  kind text not null check (kind in ('ci','comment','review_comment')),
  source_id bigint check (source_id > 0),
  head_sha text check (head_sha ~ '^[a-f0-9]{40}$'),
  status text not null default 'pending' check (status in ('pending','dispatching','delivered','ignored','blocked')),
  failures integer not null default 0 check (failures between 0 and 5),
  session_id uuid references agent_session(id) on delete set null,
  last_error text check (length(last_error) <= 500),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (link_id, dedupe_key)
);
create index pull_request_wake_pending on pull_request_wake(available_at, created_at) where status in ('pending','dispatching');
create index pull_request_wake_recent on pull_request_wake(link_id, kind, created_at);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table pull_request_link enable row level security;
alter table pull_request_wake enable row level security;
revoke all on pull_request_link, pull_request_wake from anon, authenticated;

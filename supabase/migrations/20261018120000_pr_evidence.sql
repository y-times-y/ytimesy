-- Pull request evidence (harness variant prEvidence=on). The harness captures
-- screenshots, a short recording or CLI output from a pull request's pushed
-- commit. The media lives in the private R2 checkpoint bucket under
-- pr-evidence/<sha256(user)>/<sha256(project)>/<id>/ and is only served through
-- the signed-in route /api/projects/<project>/evidence/<id>/<file>; nothing is
-- written into the user's repository. The pull request description links to
-- the evidence page /projects/<project>/evidence/<id>.
--
-- One row per capture. status 'capturing' while the background job runs;
-- otherwise the manifest status (captured, app-failed, dirty, tooling-failed).
-- files: [{name, bytes, sha256, contentType}] of the stored objects (SHA-256 as
--   captured; output.txt after secret redaction).
-- manifest: the verified capture manifest (pages, flow steps, video, CLI exit).
-- expires_at: rows and objects are removed after it, when the pull request is
--   no longer open, or with the project or account (the maintenance sweep and
--   src/server/services/pr-evidence-cleanup.ts remove the objects first).
create table pr_evidence (
  id uuid primary key,
  user_id text not null references auth_user(id) on delete cascade,
  project_id uuid not null references project(id) on delete cascade,
  session_id uuid references agent_session(id) on delete set null,
  installation_id bigint not null check (installation_id > 0),
  full_name text not null check (length(full_name) <= 200),
  pull_number integer not null check (pull_number > 0),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  head_sha text check (head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  plan_key text not null check (length(plan_key) <= 40),
  kind text not null check (kind in ('web','cli')),
  status text not null check (status in ('capturing','captured','app-failed','dirty','tooling-failed')),
  reason text not null default '' check (length(reason) <= 600),
  start_command text not null default '' check (length(start_command) <= 500),
  urls jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,
  manifest jsonb,
  browser text not null default '' check (length(browser) <= 120),
  video_seconds real,
  capture_started_at timestamptz,
  capture_finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index pr_evidence_project on pr_evidence(project_id, created_at desc);
create index pr_evidence_session on pr_evidence(session_id, created_at);
create index pr_evidence_pull on pr_evidence(project_id, full_name, pull_number, created_at desc);
create index pr_evidence_expiry on pr_evidence(expires_at);
create index pr_evidence_user on pr_evidence(user_id);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table pr_evidence enable row level security;
revoke all on pr_evidence from anon, authenticated;

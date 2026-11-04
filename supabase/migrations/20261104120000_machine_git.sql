-- Plain git on a chat's workspace VM (src/server/edge/machine-git-grant.ts).
-- Each turn step puts a short-lived machine token on the VM; only its
-- SHA-256 is kept, so any isolate can check and revoke it when the step ends.
create table machine_git_token (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 user_id text not null references auth_user(id) on delete cascade,
 session_id uuid not null references agent_session(id) on delete cascade,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);

create index machine_git_token_open on machine_git_token(user_id, session_id)
 where revoked_at is null;

alter table machine_git_token enable row level security;
revoke all on machine_git_token from public, anon, authenticated;

-- A push to a repository's default branch the git proxy refused for lack of
-- approval. request_push_approval shows it to the user; their Push sets
-- approved_at, and the proxy spends it (used_at) on the push of exactly
-- new_id to that branch, once.
create table git_push_request (
 id uuid primary key default gen_random_uuid(),
 user_id text not null references auth_user(id) on delete cascade,
 project_id uuid not null references project(id) on delete cascade,
 session_id uuid not null references agent_session(id) on delete cascade,
 owner text not null check (length(owner) between 1 and 100),
 name text not null check (length(name) between 1 and 100),
 branch text not null check (length(branch) between 1 and 255),
 old_id text not null check (old_id ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
 new_id text not null check (new_id ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
 created_at timestamptz not null default now(),
 approved_at timestamptz,
 used_at timestamptz
);

create index git_push_request_lookup on git_push_request(user_id, owner, name, branch, created_at desc);

alter table git_push_request enable row level security;
revoke all on git_push_request from public, anon, authenticated;

-- "Allow pushes to main without asking" in project settings.
alter table project add column allow_default_branch_push boolean not null default false;

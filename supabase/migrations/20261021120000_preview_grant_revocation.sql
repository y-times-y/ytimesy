-- Private preview sign-in (src/server/services/vm-edge-auth.ts).
--
-- preview_route_grant: which user may hold a preview cookie for one Freestyle
-- TLS rule (one VM port), and the version every cookie for it must carry.
-- Versions come from one sequence so a deleted-and-recreated row never
-- revives an old cookie. Withdrawing access bumps the version; deleting the
-- chat, project or account deletes the row (cascade), which also rejects
-- every cookie for it.
--
-- preview_login_nonce: one row per two-minute sign-in link, deleted when the
-- link is used, so a link signs in at most once. Expired rows are removed
-- whenever a new link is minted.
create sequence preview_route_grant_version;

create table preview_route_grant (
 rule_id text primary key check (length(rule_id) between 1 and 200),
 user_id text not null references auth_user(id) on delete cascade,
 project_id uuid not null references project(id) on delete cascade,
 session_id uuid not null references agent_session(id) on delete cascade,
 version bigint not null default nextval('preview_route_grant_version'),
 updated_at timestamptz not null default now()
);

create index preview_route_grant_scope
 on preview_route_grant(user_id, project_id, session_id);

create table preview_login_nonce (
 nonce text primary key check (length(nonce) between 16 and 200),
 rule_id text not null references preview_route_grant(rule_id) on delete cascade,
 user_id text not null references auth_user(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);

create index preview_login_nonce_expiry on preview_login_nonce(expires_at);

alter table preview_route_grant enable row level security;
alter table preview_login_nonce enable row level security;
revoke all on preview_route_grant from public, anon, authenticated;
revoke all on preview_login_nonce from public, anon, authenticated;
revoke all on sequence preview_route_grant_version from public, anon, authenticated;

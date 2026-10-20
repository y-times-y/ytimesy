-- Spent Git proxy write grants (src/domain/github-git-proxy.ts). A push grant
-- is single-use: the proxy inserts its nonce before forwarding the ref update,
-- so a grant copied off the workspace cannot be replayed. Rows are useless once
-- the grant's signature has expired and are swept on later claims.
create table git_proxy_grant_claim (
 nonce text primary key check (nonce ~ '^[a-f0-9]{32}$'),
 expires_at timestamptz not null
);

create index git_proxy_grant_claim_expiry on git_proxy_grant_claim(expires_at);

alter table git_proxy_grant_claim enable row level security;
revoke all on git_proxy_grant_claim from public, anon, authenticated;

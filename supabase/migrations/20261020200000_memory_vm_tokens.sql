-- Memory repo write tokens put on a builder's VM (src/server/services/
-- turn-memory.ts). Only the token's id is kept (never the token): any
-- isolate can revoke what an earlier durable step minted, when the turn's
-- step ends however it ends. Rows are useless once the token expires.
create table memory_vm_token (
 token_id text primary key check (length(token_id) between 1 and 200),
 user_id text not null references auth_user(id) on delete cascade,
 session_id uuid not null,
 repo text not null check (length(repo) between 1 and 200),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);

create index memory_vm_token_open on memory_vm_token(user_id, session_id)
 where revoked_at is null;

alter table memory_vm_token enable row level security;
revoke all on memory_vm_token from public, anon, authenticated;

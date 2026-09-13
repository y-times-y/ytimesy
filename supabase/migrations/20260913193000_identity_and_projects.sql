create table "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth_session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);

create table "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "auth_session_userId_idx" on "auth_session" ("userId");

create index "auth_account_userId_idx" on "auth_account" ("userId");

create index "auth_verification_identifier_idx" on "auth_verification" ("identifier");
-- A personal workspace is owned by one Better Auth user in v0.
create table github_connection (
 user_id text primary key references auth_user(id) on delete cascade,
 github_user_id text not null,
 encrypted_credentials text not null,
 updated_at timestamptz not null default now()
);
create table github_oauth_state (
 state_hash text primary key,
 user_id text not null references auth_user(id) on delete cascade,
 encrypted_verifier text not null,
 expires_at timestamptz not null
);
create index github_oauth_state_expiry on github_oauth_state(expires_at);
create table project (
 id uuid primary key,
 user_id text not null references auth_user(id) on delete cascade,
 repository_id bigint not null check (repository_id > 0),
 installation_id bigint not null check (installation_id > 0),
 full_name text not null,
 branch text not null,
 created_at timestamptz not null default now(),
 unique (user_id, repository_id)
);
create index project_owner on project(user_id, created_at);

-- Server-only data: access through authenticated application endpoints, never Data API.
alter table auth_user enable row level security;
alter table auth_session enable row level security;
alter table auth_account enable row level security;
alter table auth_verification enable row level security;
alter table auth_rate_limit enable row level security;
alter table github_connection enable row level security;
alter table github_oauth_state enable row level security;
alter table project enable row level security;
revoke all on auth_user, auth_session, auth_account, auth_verification, auth_rate_limit,
 github_connection, github_oauth_state, project from anon, authenticated;

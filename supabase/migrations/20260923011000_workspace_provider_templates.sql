create table workspace_provider_template (
 workspace_id uuid not null references workspace(id) on delete cascade,
 provider text not null check (provider in ('codex','claude')),
 auth_snapshot_id text not null,
 project_snapshot_id text not null,
 provider_ref text,
 snapshot_id text,
 status text not null check (status in ('preparing','ready','failed')),
 claimed_at timestamptz not null default now(),
 error_message text,
 updated_at timestamptz not null default now(),
 primary key (workspace_id, provider)
);

alter table workspace_provider_template enable row level security;
revoke all on workspace_provider_template from public, anon, authenticated;

-- Archive instead of delete: an archived chat or project is hidden from the
-- app and kept for 30 days (Settings > Archived restores it), then deleted.
alter table agent_session add column archived_at timestamptz;
alter table project add column archived_at timestamptz;
create index agent_session_archived on agent_session(archived_at) where archived_at is not null;
create index project_archived on project(archived_at) where archived_at is not null;

-- A finished build's VM is deleted once it is neither the workspace template nor
-- a chat's machine. Records when that happened so the release runs once.
alter table public.environment_build add column provider_released_at timestamptz;

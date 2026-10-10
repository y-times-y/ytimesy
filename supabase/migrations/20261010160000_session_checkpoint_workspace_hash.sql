-- Lets a checkpoint capture detect an unchanged workspace by hash instead of
-- downloading the previous checkpoint object after every settled turn.
alter table public.session_checkpoint add column workspace_sha256 text
 check (workspace_sha256 is null or workspace_sha256 ~ '^[a-f0-9]{64}$');

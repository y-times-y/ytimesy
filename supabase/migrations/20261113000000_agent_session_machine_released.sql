-- An archived chat's machine is released once its workspace is checkpointed
-- (services/archive.ts releaseArchivedMachines); this marks that it was done,
-- so the sweep does not try again. Restoring the chat clears it.
alter table agent_session add column if not exists machine_released_at timestamptz;

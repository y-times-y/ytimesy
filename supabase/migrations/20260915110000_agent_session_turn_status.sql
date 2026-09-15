-- Persist whether this agent session is currently running a turn so the
-- sidebar can show parallel activity without starting paused VMs.

alter table agent_session
 add column turn_status text not null default 'idle'
  check (turn_status in ('idle','running','completed','failed'));

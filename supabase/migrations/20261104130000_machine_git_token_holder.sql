-- Who holds a machine git token on the VM: a chat's agent step, or the
-- user's workspace terminal open on that chat (src/server/services/
-- terminal-machine-git.ts). A step's end revokes only its chat's step
-- tokens; a terminal's token goes when that terminal closes.
alter table machine_git_token add column holder text not null default 'step'
 check (holder in ('step','terminal'));

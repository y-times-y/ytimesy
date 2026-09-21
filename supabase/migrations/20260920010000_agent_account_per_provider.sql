-- Private auth snapshots are per harness. Codex and Claude Code can both
-- stay signed in for the same user.
alter table agent_account
	drop constraint agent_account_provider_check;
alter table agent_account
	add constraint agent_account_provider_check
	check (provider in ('codex', 'claude'));

alter table agent_account drop constraint agent_account_pkey;
alter table agent_account add primary key (user_id, provider);

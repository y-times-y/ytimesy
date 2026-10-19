-- Builder subagents (docs/subagents.md): a child started through the
-- builder's `agent` tool records its role, the budget it was given, its
-- forked VM (writers) and the model steps it has taken across turns.
alter table agent_session
	add column agent_role text
		check (agent_role in ('writer','researcher','reviewer','checker')),
	add column agent_budget jsonb,
	add column agent_fork jsonb,
	add column agent_steps integer not null default 0 check (agent_steps >= 0);

alter table agent_session
	add constraint agent_session_subagent_child
		check (agent_role is null or parent_session_id is not null);

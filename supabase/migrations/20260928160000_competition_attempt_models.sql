alter table agent_competition add column attempt_model_ids text[];

alter table agent_competition add constraint agent_competition_attempt_models check (
	attempt_model_ids is null
	or (
		cardinality(attempt_model_ids) = leader_count
		and cardinality(attempt_model_ids) between 2 and 5
	)
);

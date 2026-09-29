alter table agent_competition
 add column attempt_model_ids text[];

alter table agent_competition
 add constraint agent_competition_attempt_models_valid
 check (
  attempt_model_ids is null or (
   cardinality(attempt_model_ids) = leader_count
   and array_position(attempt_model_ids, null) is null
  )
 );

-- Remember the listed model last submitted on this agent session so a
-- paused follow-up or side copy can reuse it instead of re-preferring a
-- provider-blocked Zen spark default.

alter table agent_session
 add column listed_model_id text;

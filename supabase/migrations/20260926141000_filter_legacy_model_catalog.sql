-- Legacy sessions could retain a selection from a different runtime.
update agent_model_catalog
set models = coalesce((
  select jsonb_agg(model) from jsonb_array_elements(models) model
  where not (
    (provider = 'claude' and (model->>'id' like 'gpt-%' or model->>'id' like 'o_-%'))
    or (provider = 'codex' and (model->>'id' like 'claude-%' or model->>'id' in ('opus','sonnet','fable')))
  )
), '[]'::jsonb);

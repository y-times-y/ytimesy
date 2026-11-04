-- A push card waits on the user only until the chat shows its answer.
create or replace function public.agent_session_waiting_on(items jsonb, turn_status text) returns text
 language sql immutable as $$
 select case when turn_status = 'running' then null else coalesce((
  select case t.it->>'kind' when 'userQuestion' then 'question' when 'secretRequest' then 'secret'
   when 'pushApproval' then 'push' when 'planProposal' then 'plan' else 'paused' end
  from (select e.it, e.o,
         max(case when jsonb_typeof(e.it) = 'null' or public.agent_session_item_starts_turn(e.it)
          then e.o end) over () as last_start
        from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end)
         with ordinality e(it, o)) t
  where t.o > coalesce(t.last_start, 0)
   and (t.it->>'kind' in ('userQuestion','secretRequest','planProposal')
    or (t.it->>'kind' = 'pushApproval' and not exists (
      select 1 from jsonb_array_elements(items) answered(n)
      where answered.n->>'kind' = 'notice'
        and answered.n->'pushResult'->>'requestId' = t.it->>'requestId'))
    or (t.it->>'kind' = 'modelSwitch' and t.it->>'state' = 'awaitingApproval'))
  order by t.o desc limit 1
 ), case when turn_status = 'failed' then 'failed' end) end
$$;

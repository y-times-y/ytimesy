-- A push approval card (request_push_approval) waits on the user too:
-- chatWaitingOn in src/domain/sidebar-chats.ts says 'push'. Same function as
-- 20261026110000_agent_session_waiting_on.sql with that kind added; the
-- trigger calls it by name, so no row changes until it is next written
-- (no chat holds a push card before this deploy).
alter table public.agent_session drop constraint agent_session_waiting_on_check;
alter table public.agent_session add constraint agent_session_waiting_on_check
 check (waiting_on in ('question','secret','push','plan','paused','failed'));

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
   and (t.it->>'kind' in ('userQuestion','secretRequest','pushApproval','planProposal')
    or (t.it->>'kind' = 'modelSwitch' and t.it->>'state' = 'awaitingApproval'))
  order by t.o desc limit 1
 ), case when turn_status = 'failed' then 'failed' end) end
$$;

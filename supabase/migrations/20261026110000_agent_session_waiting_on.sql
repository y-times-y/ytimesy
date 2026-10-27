-- What a chat waits on from the user (chatWaitingOn in
-- src/domain/sidebar-chats.ts), kept on the row so the sidebar reads one
-- column instead of each chat's history. A trigger recomputes it whenever
-- items or turn_status is written, by any writer (old code included).
alter table public.agent_session
 add column waiting_on text check (waiting_on in ('question','secret','plan','paused','failed'));

-- chatWaitingOn: not while running; else the newest card only the user can
-- answer after the item that started the last turn (a null item also stops
-- the scan, as it does there); else 'failed' when the last turn failed.
create function public.agent_session_waiting_on(items jsonb, turn_status text) returns text
 language sql immutable as $$
 select case when turn_status = 'running' then null else coalesce((
  select case t.it->>'kind' when 'userQuestion' then 'question' when 'secretRequest' then 'secret'
   when 'planProposal' then 'plan' else 'paused' end
  from (select e.it, e.o,
         max(case when jsonb_typeof(e.it) = 'null' or public.agent_session_item_starts_turn(e.it)
          then e.o end) over () as last_start
        from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end)
         with ordinality e(it, o)) t
  where t.o > coalesce(t.last_start, 0)
   and (t.it->>'kind' in ('userQuestion','secretRequest','planProposal')
    or (t.it->>'kind' = 'modelSwitch' and t.it->>'state' = 'awaitingApproval'))
  order by t.o desc limit 1
 ), case when turn_status = 'failed' then 'failed' end) end
$$;

create function public.agent_session_waiting_on_sync() returns trigger
 language plpgsql as $$
begin
 new.waiting_on := public.agent_session_waiting_on(new.items, new.turn_status);
 return new;
end $$;

create trigger agent_session_waiting_on_sync
 before insert or update of items, turn_status on public.agent_session
 for each row execute function public.agent_session_waiting_on_sync();

-- Backfill under a write lock (committed with the trigger), in batches;
-- only rows that wait on something are rewritten.
lock table public.agent_session in share row exclusive mode;
do $$
declare
 last_id uuid := null;
 batch uuid[];
begin
 loop
  select array_agg(id order by id) into batch
   from (select id from public.agent_session
         where last_id is null or id > last_id order by id limit 200) b;
  exit when batch is null;
  update public.agent_session s
   set waiting_on = public.agent_session_waiting_on(s.items, s.turn_status)
   where s.id = any(batch)
    and s.waiting_on is distinct from public.agent_session_waiting_on(s.items, s.turn_status);
  last_id := batch[array_length(batch, 1)];
 end loop;
end $$;

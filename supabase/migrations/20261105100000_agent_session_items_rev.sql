-- A revision for the transcript, so the browser can ask "anything new since
-- revision V?" and read only the item rows that changed.
--
-- agent_session.items_rev counts the writes of agent_session.items (it only
-- grows). Each agent_session_item row records the revision that last wrote it
-- (rev). Writers of one chat are serialized by the chat row's lock, so revisions
-- of one chat are in commit order: a reader at revision V has seen every row
-- whose rev <= V and none of the later ones. A write that sets items to the
-- value it holds (the queue's `items=items`) still bumps the revision and
-- changes no row.
alter table public.agent_session add column items_rev bigint not null default 0;
alter table public.agent_session_item add column rev bigint not null default 0;

create function public.agent_session_items_rev_bump() returns trigger
 language plpgsql as $$
begin
 new.items_rev := old.items_rev + 1;
 return new;
end $$;

create trigger agent_session_items_rev_bump
 before update of items on public.agent_session
 for each row execute function public.agent_session_items_rev_bump();

-- The mirror now also stamps the revision on the rows it writes.
create or replace function public.agent_session_item_sync() returns trigger
 language plpgsql as $$
declare
 next jsonb;
 prev jsonb := '[]'::jsonb;
begin
 if tg_op = 'UPDATE' then
  if new.items is not distinct from old.items then return null; end if;
  if jsonb_typeof(old.items) = 'array' then prev := old.items; end if;
 end if;
 next := case when jsonb_typeof(new.items) = 'array' then new.items else '[]'::jsonb end;
 insert into public.agent_session_item as i(session_id, position, kind, item_id, starts_turn, item, rev)
 select new.id, n.o - 1, n.it->>'kind', n.it->>'id', public.agent_session_item_starts_turn(n.it), n.it, new.items_rev
 from jsonb_array_elements(next) with ordinality n(it, o)
 left join jsonb_array_elements(prev) with ordinality p(it, o) on p.o = n.o
 where p.it is distinct from n.it
 on conflict (session_id, position) do update
  set kind = excluded.kind, item_id = excluded.item_id,
      starts_turn = excluded.starts_turn, item = excluded.item, rev = excluded.rev;
 if jsonb_array_length(prev) > jsonb_array_length(next) then
  delete from public.agent_session_item
   where session_id = new.id and position >= jsonb_array_length(next);
 end if;
 return null;
end $$;

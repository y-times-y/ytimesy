-- One row per transcript item, so a chat page reads only its own rows
-- instead of detoasting the whole agent_session.items array.
--
-- agent_session.items stays the write path for now: every writer (and the
-- code of a deploy still rolling out) keeps setting the array, and the
-- trigger below mirrors each change into agent_session_item in the same
-- statement, writing only the positions that changed. Reads of transcript
-- pages, older pages and realtime snapshots come from this table. A later
-- migration can move writers to rows and drop the column.
create table public.agent_session_item (
 session_id uuid not null references public.agent_session(id) on delete cascade,
 -- 0-based index of the item in agent_session.items.
 position integer not null check (position >= 0),
 kind text,
 item_id text,
 -- Starts a turn (startsTurn in src/domain/child-task-activity.ts and
 -- STARTS_TURN_SQL in src/server/adapters/transcript-page-sql.ts).
 starts_turn boolean not null,
 item jsonb not null,
 created_at timestamptz not null default now(),
 primary key (session_id, position)
);
-- Page boundaries: the last N turn starts before a position.
create index agent_session_item_turn_start
 on public.agent_session_item(session_id, position) where starts_turn;
-- Older-page cursors name an item by id.
create index agent_session_item_item_id
 on public.agent_session_item(session_id, item_id);

alter table public.agent_session_item enable row level security;
revoke all on public.agent_session_item from anon, authenticated;

create function public.agent_session_item_starts_turn(it jsonb) returns boolean
 language sql immutable as $$
 select coalesce(it->>'kind'='userMessage' or (it->>'kind'='notice' and it->>'wake'='true'), false)
$$;

-- Mirrors a change of agent_session.items: upserts each position whose item
-- changed and deletes positions past the new end.
create function public.agent_session_item_sync() returns trigger
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
 insert into public.agent_session_item as i(session_id, position, kind, item_id, starts_turn, item)
 select new.id, n.o - 1, n.it->>'kind', n.it->>'id', public.agent_session_item_starts_turn(n.it), n.it
 from jsonb_array_elements(next) with ordinality n(it, o)
 left join jsonb_array_elements(prev) with ordinality p(it, o) on p.o = n.o
 where p.it is distinct from n.it
 on conflict (session_id, position) do update
  set kind = excluded.kind, item_id = excluded.item_id,
      starts_turn = excluded.starts_turn, item = excluded.item;
 if jsonb_array_length(prev) > jsonb_array_length(next) then
  delete from public.agent_session_item
   where session_id = new.id and position >= jsonb_array_length(next);
 end if;
 return null;
end $$;

create trigger agent_session_item_sync
 after insert or update of items on public.agent_session
 for each row execute function public.agent_session_item_sync();

-- Backfill under a write lock, so no change to items lands between the copy
-- and the trigger taking over (both commit together). Reads continue.
-- Batches of chats bound each statement's memory; rerunnable.
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
  insert into public.agent_session_item(session_id, position, kind, item_id, starts_turn, item)
  select s.id, e.o - 1, e.it->>'kind', e.it->>'id', public.agent_session_item_starts_turn(e.it), e.it
  from public.agent_session s
  cross join lateral jsonb_array_elements(
   case when jsonb_typeof(s.items) = 'array' then s.items else '[]'::jsonb end
  ) with ordinality e(it, o)
  where s.id = any(batch)
  on conflict (session_id, position) do nothing;
  last_id := batch[array_length(batch, 1)];
 end loop;
end $$;

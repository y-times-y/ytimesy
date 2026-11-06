-- Open background commands (idleSessionsWithOpenBackgroundCommands): the sweep
-- ran jsonb_path_exists over agent_session.items of every recent chat. The
-- mirrored agent_session_item rows hold each item on its own, and this partial
-- index holds only the items of a command that has not exited, so the sweep
-- reads the few open commands instead of every transcript. The predicate is the
-- SQL form of the old jsonpath
-- (@.kind == "dynamicToolCall" && exists(@.background) && !exists(@.background.exitCode)).
--
-- One table per migration: each takes a short lock on a single table, so none
-- can deadlock with live traffic that touches the others in a different order.
set local lock_timeout = '5s';

create index agent_session_item_open_background
 on public.agent_session_item(session_id)
 where kind = 'dynamicToolCall'
  and item->'background' is not null
  and (item #> '{background,exitCode}') is null;

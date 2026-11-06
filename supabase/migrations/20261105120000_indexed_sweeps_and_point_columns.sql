-- Three lookups that scaled with the number of chats or the size of stored JSON.
--
-- 1. Open background commands (idleSessionsWithOpenBackgroundCommands): the
--    sweep ran jsonb_path_exists over agent_session.items of every recent
--    chat. The mirrored agent_session_item rows hold each item on its own, and
--    this partial index holds only the items of a command that has not exited,
--    so the sweep reads the few open commands instead of every transcript.
--    The predicate is the SQL form of the old jsonpath
--    (@.kind == "dynamicToolCall" && exists(@.background) && !exists(@.background.exitCode)).
--
-- 2. Conversation points (listConversationRecoveryPoints): listing a chat's
--    restore points read each receipt's whole response (the full transcript at
--    that prompt, up to about 1 MB) only to learn two small facts. They are now
--    stored columns derived from the response, so the list never detoasts it.
--    Generated, so every writer, including the code of a deploy still rolling
--    out, keeps them correct without being changed.
--
-- 3. Finished subagent turns (recoverChildTurnEvents): "no newer turn in the
--    same chat" walked api_turn_worker (state, created_at) and filtered by
--    chat, so each candidate read every newer turn of every chat. The query now
--    takes each subagent chat's latest turn, which needs the turns of one chat
--    in creation order. agent_task_event.child_session_id (a foreign key) gets
--    the index its anti-join and the cascade delete of a chat both lacked.
--
-- Cost: the receipt change rewrites agent_task_command_receipt once (a few
-- hundred rows, about 13 MB of TOAST in production) under an exclusive lock;
-- lock_timeout makes the migration give up rather than queue behind a long
-- transaction. The two new indexes add one index entry per api_turn insert and
-- per open background command.
set local lock_timeout = '5s';

create index agent_session_item_open_background
 on public.agent_session_item(session_id)
 where kind = 'dynamicToolCall'
  and item->'background' is not null
  and (item #> '{background,exitCode}') is null;

alter table public.agent_task_command_receipt
 add column point_message_id text
  generated always as (response->'result'->>'userMessageId') stored,
 add column point_has_code boolean
  generated always as (
   coalesce(jsonb_typeof(response->'result'->'code') not in ('null'), false)
  ) stored;

create index api_turn_session_created on public.api_turn(session_id, created_at);
create index agent_task_event_child on public.agent_task_event(child_session_id);

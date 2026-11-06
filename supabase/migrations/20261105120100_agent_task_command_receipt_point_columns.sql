-- Conversation points (listConversationRecoveryPoints): listing a chat's restore
-- points read each receipt's whole response (the full transcript at that
-- prompt, up to about 1 MB) only to learn two small facts. They are now stored
-- columns derived from the response, so the list never detoasts it. Generated,
-- so every writer, including the code of a deploy still rolling out, keeps them
-- correct without being changed.
--
-- Cost: this rewrites agent_task_command_receipt once (a few hundred rows, about
-- 13 MB of TOAST in production) under an exclusive lock; lock_timeout makes the
-- migration give up rather than queue behind a long transaction.
set local lock_timeout = '5s';

alter table public.agent_task_command_receipt
 add column point_message_id text
  generated always as (response->'result'->>'userMessageId') stored,
 add column point_has_code boolean
  generated always as (
   coalesce(jsonb_typeof(response->'result'->'code') not in ('null'), false)
  ) stored;

-- A message the user sends while a turn runs waits in the chat's safe-point
-- inbox. The running turn delivers it at its next model step; whatever is still
-- waiting when the turn ends starts the next turn.
--
-- queued_send: the composer's send (the timeline item with its stored
--   attachments, plus the model and settings for a turn it may start). Null for
--   runtime notices (peer messages, child task events).
alter table agent_peer_inbox add column queued_send jsonb;
-- A user's message is as long as the composer allows; runtime notices keep their bound.
alter table agent_peer_inbox drop constraint agent_peer_inbox_message_check;
alter table agent_peer_inbox add constraint agent_peer_inbox_message_check
  check (length(message) <= 12000 or (queued_send is not null and length(message) <= 1000000));

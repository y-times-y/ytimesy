-- Finished subagent turns (recoverChildTurnEvents): "no newer turn in the same
-- chat" walked api_turn_worker (state, created_at) and filtered by chat, so each
-- candidate read every newer turn of every chat. The query now takes each
-- subagent chat's latest turn, which needs the turns of one chat in creation
-- order. Adds one index entry per api_turn insert.
set local lock_timeout = '5s';

create index api_turn_session_created on public.api_turn(session_id, created_at);

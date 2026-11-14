-- The items revision (agent_session.items_rev) of the last snapshot the chat's
-- realtime room took, so the next delivery reads and sends only the item rows
-- written since (agent_session_item.rev > it) instead of the whole latest page.
-- Null (every existing row) means unknown: the next delivery is a full
-- snapshot. Only a hint: a room at another revision refuses the delta and is
-- sent a full snapshot.
-- A nullable column without a default changes only the catalog: no rewrite.
set local lock_timeout = '5s';

alter table public.conversation_delivery add column delivered_items_rev bigint;

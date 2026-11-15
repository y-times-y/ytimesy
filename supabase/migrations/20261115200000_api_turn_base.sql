-- A turn that continues a settled turn's history unchanged records which
-- turn (and the row version and message count it saw): the send copies that
-- history inside the database instead of reading it, and the chat's Durable
-- Object, holding the same history from when that turn ended, reads only the
-- messages after it.
alter table public.api_turn
  add column if not exists base_turn_id uuid,
  add column if not exists base_version text,
  add column if not exists base_count integer;

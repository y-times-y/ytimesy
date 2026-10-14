-- The reasoning level and speed an API-key turn was sent with
-- ({"reasoning":"high","speed":"fast"}); empty means the model's defaults.
alter table api_turn
  add column settings jsonb not null default '{}'::jsonb;

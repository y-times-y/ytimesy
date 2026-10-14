-- Automatic model failover. A turn whose model route became unavailable
-- continues on a fallback route; `failover` holds that route (sticky for the
-- rest of the turn), every route the turn tried, and how many times it moved:
-- {"route":{"connectionId":...,"connectionRevision":...,"modelId":...,"settings":{}},
--  "label":{"model":...,"connection":...},"tried":[...],"triedLabels":[...],"switches":1}
-- connection_id, connection_revision and model_id keep the user's choice.
alter table api_turn
  add column failover jsonb;

-- Each user's failover preferences. connection_order lists connection keys
-- ("codex" for the ChatGPT plan, otherwise model_connection ids), best first;
-- connections it does not list follow in the default order.
create table model_failover_preference (
  user_id text primary key references auth_user(id) on delete cascade,
  enabled boolean not null default true,
  ask_before_paid boolean not null default false,
  connection_order jsonb not null default '[]'::jsonb
    check (jsonb_typeof(connection_order) = 'array' and jsonb_array_length(connection_order) <= 64),
  updated_at timestamptz not null default now()
);
alter table model_failover_preference enable row level security;
revoke all on model_failover_preference from anon, authenticated;

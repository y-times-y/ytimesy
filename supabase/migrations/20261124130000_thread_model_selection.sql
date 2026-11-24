-- A selection made outside a turn applies until the next turn is started.
alter table public.agent_session add column model_selection jsonb;

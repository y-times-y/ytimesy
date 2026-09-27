create table agent_model_catalog (
  user_id text not null references auth_user(id) on delete cascade,
  provider text not null check (provider in ('codex', 'claude')),
  models jsonb not null check (jsonb_typeof(models) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table agent_model_catalog enable row level security;
revoke all on agent_model_catalog from anon, authenticated;

-- Older sessions retained the chosen model, but not the full provider catalog.
insert into agent_model_catalog(user_id, provider, models)
select user_id, harness,
  jsonb_agg(jsonb_build_object('id', listed_model_id, 'label', listed_model_id))
from (
  select distinct user_id, harness, listed_model_id from agent_session
  where harness in ('codex', 'claude')
    and listed_model_id is not null and btrim(listed_model_id) <> ''
) remembered
group by user_id, harness;

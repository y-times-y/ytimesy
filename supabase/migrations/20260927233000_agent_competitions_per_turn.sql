alter table agent_competition add column id uuid not null default gen_random_uuid();
alter table agent_competition add column user_message_id text;

update agent_competition c
set user_message_id = coalesce(
  (select item->>'id' from agent_session s,
    lateral jsonb_array_elements(s.items) item
   where s.id = c.root_session_id and item->>'kind' = 'userMessage'
   limit 1),
  'competition-' || c.root_session_id::text
);

alter table agent_competition alter column user_message_id set not null;
alter table agent_competition drop constraint agent_competition_pkey;
alter table agent_competition add primary key (id);
create unique index agent_competition_message on agent_competition(root_session_id,user_message_id);
create unique index agent_competition_one_active on agent_competition(root_session_id)
 where status in ('queued','working','judging');

alter table agent_session add column competition_id uuid references agent_competition(id) on delete set null;
update agent_session s set competition_id = c.id
from agent_competition c
where s.parent_session_id = c.root_session_id and s.candidate_index is not null;

drop index agent_session_candidate_position;
create unique index agent_session_candidate_position on agent_session(competition_id,candidate_index)
 where competition_id is not null and candidate_index is not null;
create index agent_session_competition on agent_session(competition_id);

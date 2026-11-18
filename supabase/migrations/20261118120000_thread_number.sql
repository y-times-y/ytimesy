-- Readable thread names (src/domain/thread-label.ts): "<project>-<number>",
-- the number counting up per project in the order threads were created. A
-- number is never reused, even when the thread is archived, so a name in an
-- old message keeps meaning the same thread.
--
-- Only root threads are numbered: not a project's Y² chat (chat_role) and
-- not a subagent (parent_session_id).
set local lock_timeout = '5s';

alter table project add column thread_counter integer not null default 0;
alter table agent_session add column thread_number integer;

-- Existing threads, in creation order (the id breaks a tie).
with numbered as (
  select id, row_number() over (partition by project_id order by created_at, id) as n
  from agent_session
  where parent_session_id is null and chat_role is null
)
update agent_session s set thread_number = numbered.n
from numbered where s.id = numbered.id;

update project p set thread_counter = coalesce(
  (select max(s.thread_number) from agent_session s where s.project_id = p.id), 0);

create unique index agent_session_thread_number
  on agent_session(project_id, thread_number)
  where thread_number is not null;

-- A new root thread takes the project's next number. The project row is the
-- counter, so two threads created at once queue on its row lock and get
-- different numbers.
create function agent_session_assign_thread_number() returns trigger
  language plpgsql as $$
begin
  if new.thread_number is null and new.parent_session_id is null and new.chat_role is null then
    update project set thread_counter = thread_counter + 1
    where id = new.project_id
    returning thread_counter into new.thread_number;
  end if;
  return new;
end
$$;

create trigger agent_session_thread_number
  before insert on agent_session
  for each row execute function agent_session_assign_thread_number();

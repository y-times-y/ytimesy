alter table public.api_turn add column executor text not null default 'node'
  check (executor in ('node', 'durable-object'));

create function public.preserve_api_turn_executor() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.executor is distinct from new.executor and old.state <> 'queued' then
    raise exception 'An admitted turn cannot change executor';
  end if;
  return new;
end;
$$;
create trigger api_turn_executor_immutable before update of executor
  on public.api_turn for each row execute function public.preserve_api_turn_executor();
revoke all on function public.preserve_api_turn_executor() from public, anon, authenticated;

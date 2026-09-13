-- Match the project's automatic-RLS setting for tables created by SQL migrations.
-- Policies remain explicit: enabling RLS alone grants no client access.
create function public.ytimesy_enable_new_table_rls()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_table record;
begin
  for created_table in
    select namespace.nspname as schema_name, relation.relname as table_name
    from pg_event_trigger_ddl_commands() as command
    join pg_class as relation on relation.oid = command.objid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where command.classid = 'pg_class'::regclass
      and namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and not command.in_extension
  loop
    execute format(
      'alter table %I.%I enable row level security',
      created_table.schema_name,
      created_table.table_name
    );
  end loop;
end;
$$;

revoke all on function public.ytimesy_enable_new_table_rls() from public;

create event trigger ytimesy_enable_new_table_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.ytimesy_enable_new_table_rls();

-- The native agent runtimes (Claude Code, OpenCode, native Codex) are retired:
-- chats run only on our harness (codex = ChatGPT subscription, api = API
-- connections). Chats are user data, so this stops rather than deleting any
-- that still name a retired runtime.
do $$
begin
  if exists (select 1 from agent_session where harness not in ('codex', 'api'))
     or exists (select 1 from agent_competition where harness not in ('codex', 'api')) then
    raise exception 'Chats or competitions still use a retired runtime; resolve them before this migration.';
  end if;
end $$;

alter table agent_session drop constraint agent_session_harness_check;
alter table agent_session add constraint agent_session_harness_check
  check (harness in ('codex', 'api'));

alter table agent_competition drop constraint agent_competition_harness_check;
alter table agent_competition add constraint agent_competition_harness_check
  check (harness in ('codex', 'api'));

-- Retired provider logins and model lists, and the native login snapshot id.
delete from agent_account where provider <> 'codex';
alter table agent_account drop constraint agent_account_provider_check;
alter table agent_account add constraint agent_account_provider_check
  check (provider = 'codex');
alter table agent_account drop column encrypted_snapshot_id;

delete from agent_model_catalog where provider <> 'codex';
alter table agent_model_catalog drop constraint agent_model_catalog_provider_check;
alter table agent_model_catalog add constraint agent_model_catalog_provider_check
  check (provider = 'codex');

drop table claude_home;
drop table user_harness_api_key;
drop table workspace_provider_template;

-- ytimesy never uses the Supabase Data API (PostgREST). With the Data API
-- turned off, Supabase points PostgREST at a schema that does not exist, so it
-- fails, reconnects every 32 seconds and logs ~6 lines each time (~75% of the
-- project's log ingestion). Exposing only this empty schema instead lets
-- PostgREST load and stay quiet while serving nothing: no tables, no
-- functions, and no access for the API roles.
create schema if not exists no_data_api;
revoke all on schema no_data_api from public, anon, authenticated;

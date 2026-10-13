-- A ChatGPT device-code sign-in the web server is waiting on (sealed device id
-- and user code). Cleared when the login completes, fails or expires.
alter table agent_account
  add column encrypted_device_login text;

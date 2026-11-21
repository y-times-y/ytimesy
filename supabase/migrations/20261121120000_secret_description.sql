-- What a secret is and what it can do, written by the agent after it tested the
-- credential (provider, whose identity, what it can do, how it was tested, when).
-- Never a value. Shown to every later chat beside the secret's name, so nothing
-- is researched twice. A save of the secret's value clears it.
alter table project_secret
  add column if not exists description text
  check (description is null or char_length(description) <= 500);
alter table account_secret
  add column if not exists description text
  check (description is null or char_length(description) <= 500);

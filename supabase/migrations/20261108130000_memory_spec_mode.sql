-- Memory moves from the read/save hooks ("full") to the spec's loop ("spec"):
-- the builder reads and saves memory itself and dreaming consolidates it.
-- Rows keep working in either mode; this only moves existing users over and
-- makes spec the default for new ones.
alter table user_memory alter column mode set default 'spec';
update user_memory set mode = 'spec' where mode = 'full';

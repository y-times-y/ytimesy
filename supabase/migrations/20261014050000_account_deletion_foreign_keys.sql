-- Deleting an account deletes its auth_user row and lets every owned row go
-- with it. Three references blocked that (no ON DELETE action):
--   infrastructure_vm_admission.user_id  -> cascade (the VMs are destroyed first;
--     the usage reservations it points at stay as the spend ledger)
--   workspace_retention.user_id          -> cascade (recovery records of the user's chats)
--   infrastructure_provider_statement.imported_by -> set null (provider bills
--     stay; only the admin who imported them is forgotten)
-- All other foreign keys to auth_user already cascade (audited 2026-10-14).
alter table public.infrastructure_vm_admission
	drop constraint infrastructure_vm_admission_user_id_fkey,
	add constraint infrastructure_vm_admission_user_id_fkey
		foreign key (user_id) references public.auth_user(id) on delete cascade;

alter table public.workspace_retention
	drop constraint workspace_retention_user_id_fkey,
	add constraint workspace_retention_user_id_fkey
		foreign key (user_id) references public.auth_user(id) on delete cascade;

alter table public.infrastructure_provider_statement
	alter column imported_by drop not null,
	drop constraint infrastructure_provider_statement_imported_by_fkey,
	add constraint infrastructure_provider_statement_imported_by_fkey
		foreign key (imported_by) references public.auth_user(id) on delete set null;

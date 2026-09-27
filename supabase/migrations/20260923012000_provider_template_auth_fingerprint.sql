update workspace_provider_template
set auth_snapshot_id = md5(auth_snapshot_id);

alter table workspace_provider_template
rename column auth_snapshot_id to auth_snapshot_fingerprint;

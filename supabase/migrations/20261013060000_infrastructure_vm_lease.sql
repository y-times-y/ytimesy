-- Per-VM admission lock as an expiring lease. A session advisory lock leaked
-- whenever an edge invocation died before unlocking: the pooled connection kept
-- the lock and every later admission for that VM timed out. A lease expires.
create table infrastructure_vm_lease (
 slug text primary key,
 holder uuid not null,
 expires_at timestamptz not null
);
alter table infrastructure_vm_lease enable row level security;
revoke all on infrastructure_vm_lease from anon, authenticated;

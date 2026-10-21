-- Per-project internet access for chat machines (src/domain/vm-network-policy.ts).
-- full: open internet (default, today's behaviour); defaults: built-in
-- developer domains plus network_domains; allowlist: network_domains only.
-- Applied to each chat machine when it is next bound for a turn.
alter table public.project
  add column network_mode text not null default 'full'
    check (network_mode in ('full', 'defaults', 'allowlist')),
  add column network_domains text[] not null default '{}'
    check (cardinality(network_domains) <= 50);

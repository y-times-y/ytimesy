alter table public.project add column machine_size text not null default 'large'
  check (machine_size in ('small', 'medium', 'large', 'extra-large'));

-- Product-wide first-boot image. Not a user secret and not a project snapshot.
create table product_setting (
 key text primary key,
 value text not null,
 updated_at timestamptz not null default now()
);
alter table product_setting enable row level security;
revoke all on product_setting from anon, authenticated;

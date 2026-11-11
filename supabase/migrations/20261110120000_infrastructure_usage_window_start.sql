-- Usage windows reset at a fixed time, the way Claude's do: a user's first
-- usage after a window ends starts the next window, its reset time is
-- started_at plus the window (5 hours or 7 days), and then all of its usage
-- clears (src/domain/infrastructure-usage.ts). Previously each charge left a
-- rolling window on its own, so the shown reset time kept moving later.
create table public.infrastructure_usage_window (
 user_id text not null references public.auth_user(id) on delete cascade,
 window_id text not null check (window_id in ('five_hour','weekly')),
 started_at timestamptz not null,
 primary key (user_id, window_id)
);
alter table public.infrastructure_usage_window enable row level security;
revoke all on public.infrastructure_usage_window from anon, authenticated;

-- Windows already in progress start at their user's first usage inside them.
insert into public.infrastructure_usage_window(user_id,window_id,started_at)
select r.user_id, w.window_id, min(r.created_at)
from public.infrastructure_usage_reservation r
join (values ('five_hour', interval '5 hours'), ('weekly', interval '7 days')) w(window_id, length)
 on r.created_at > now() - w.length
join public.auth_user u on u.id = r.user_id
group by r.user_id, w.window_id;

-- Window reads count a user's charges from the window's start.
create index infrastructure_usage_reservation_user_created
 on public.infrastructure_usage_reservation(user_id,created_at);

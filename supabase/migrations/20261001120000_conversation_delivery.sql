-- A bounded current-state mailbox, not a transcript copy for every streamed token.
create sequence conversation_delivery_revision;
create table conversation_delivery (
  session_id uuid primary key references agent_session(id) on delete cascade,
  revision bigint not null default nextval('conversation_delivery_revision'),
  delivered_revision bigint not null default 0,
  retry_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0
);
alter table conversation_delivery enable row level security;
revoke all on conversation_delivery from anon, authenticated;
revoke all on sequence conversation_delivery_revision from anon, authenticated;
create index conversation_delivery_pending on conversation_delivery(retry_at)
  where revision > delivered_revision;

create function mark_conversation_delivery() returns trigger language plpgsql as $$
begin
  if new.harness not in ('api','codex') then return new; end if;
  insert into conversation_delivery(session_id) values(new.id)
  on conflict(session_id) do update set
    revision=nextval('conversation_delivery_revision'),
    retry_at=case when conversation_delivery.attempts=0 then now() else conversation_delivery.retry_at end;
  perform pg_notify('ytimesy_progress', new.id::text);
  return new;
end;
$$;
create trigger conversation_delivery_changed
after insert or update of items,turn_status on agent_session
for each row execute function mark_conversation_delivery();
insert into conversation_delivery(session_id)
  select id from agent_session where harness in ('api','codex');

-- Shared-harness safe-point input belongs on the control plane, not the execution VM.
create table agent_peer_inbox (
  id text primary key,
  recipient_id uuid not null references agent_session(id) on delete cascade,
  message text not null check (length(message)<=12000),
  accepted boolean not null default false,
  created_at timestamptz not null default now()
);
alter table agent_peer_inbox enable row level security;
revoke all on agent_peer_inbox from anon, authenticated;
create index agent_peer_inbox_pending on agent_peer_inbox(recipient_id,created_at) where not accepted;

create function notify_api_turn_queued() returns trigger language plpgsql as $$
begin
  perform pg_notify('ytimesy_turn_queued',new.id::text);
  return new;
end;
$$;
create trigger api_turn_queued after insert on api_turn
for each row when (new.state='queued') execute function notify_api_turn_queued();

-- request_push_approval no longer ends the turn and Push pushes server-side
-- (src/server/services/push-approval.ts). A request's answer lives on its
-- row: pushed, failed (nothing pushed), cancelled, outdated or expired.
-- noticed_at: the chat got its timeline notice (a notice item with
-- pushResult.requestId), appended at once when the chat is idle, else by
-- the running turn's next step.
alter table git_push_request add column requested_at timestamptz;
alter table git_push_request add column answer text
 check (answer in ('pushed','failed','cancelled','outdated','expired'));
alter table git_push_request add column answer_detail text check (length(answer_detail) <= 300);
alter table git_push_request add column answered_at timestamptz;
alter table git_push_request add column noticed_at timestamptz;

create index git_push_request_unnoticed on git_push_request(session_id)
 where answer is not null and noticed_at is null;

-- The Freestyle identity a Claude Code turn's runner box uses to run its
-- workspace tools on the chat's VM (docs/claude-code-placement.md,
-- "Workspace tools on the box"). Its token never expires, so the id is kept
-- here from before the identity is granted anything until it is deleted: at
-- turn end, lease loss or VM replacement, or by the sweep for turns that are
-- no longer running. Only the id; the token is never stored.
alter table public.api_turn
  add column if not exists box_tool_identity text;

create index if not exists api_turn_box_tool_identity_idx
  on public.api_turn (updated_at)
  where box_tool_identity is not null;

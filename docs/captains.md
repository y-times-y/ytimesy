# Captains

Additional Super agents of a project. Y² stays the project's leader and works exactly as before (docs/y.md); a captain is a Y²-like chat with a name, a colour, an optional label (a sidebar group) and role instructions. Design: the canvas "Artifacts and captains design", section B. Built in three steps; this file says what each one does.

## Cost rules (why it is cheap)

- A captain is **data plus one chat** (`captain` row, `agent_session.chat_role = 'captain'`). No Durable Object, no machine, no timer and no heartbeat of its own: nothing runs for an idle captain, so it costs nothing.
- A captain turn runs only when a message reaches its chat: the person writes to it, another Super agent messages it, it is @mentioned, or an event of a thread it owns wakes it (steps 2 and 3). Those go through the same send path, the same admission, the same quiet-wake rules and the same per-user caps (`Y_WAKES_PER_USER_PER_DAY`) as Y²; the model is the project's own connection.
- At most **5 captains per project** (`CAPTAIN_LIMIT`, enforced in the create statement under a lock on the project row).
- Captains are not threads: `listSidebarAgentSessions` leaves them out, and a captain's turns are never noted to the crew (`crew-facts.ts` and the executor read `yEnabled = false` for a captain chat), so they never wake Y² or sit in its thread list.

## Step 1: data, API, sidebar, direct chat

- **Migration** `20261126130000_captains.sql` (additive): `captain(id, user_id, project_id, chat_id, name, label, color, role_prompt, position, last_line, last_at, created_at, archived_at)`, RLS on and no grants (the server reads it); `agent_session.chat_role` accepts `'captain'` beside `'y2'` (the existing check is looked up and replaced); `project.leader_name`. A live name is unique per project by its @handle (lower case, spaces as dashes).
- **Code**: `src/domain/captain.ts` (schema, limits, grouping, status, role instructions), `src/server/adapters/captains.ts` (create/list/update/archive/last line/leader name), `src/features/captains/` (server functions, sidebar section, create/edit dialog).
- **Runtime**: a captain's turn is a Super-agent turn (no machine, no branch, Y²'s tools and safety rules): `projectYMode(user, project, sessionId)` says whether the chat is a live captain, and `superAgentInstructions` puts the captain's role (as quoted data) in front of Y²'s instructions, with the fixed rules after it. The send gate (`api-turns.ts`), box routing (`turn-runner-boxes.ts`), the Y² port on boxes and `isYSquaredSession` / `isActiveYSquaredChat` treat a captain like Y².
- **Sidebar**: a Captains section for the open project (Y on): the leader row, captains grouped by label with status, the first line of the last answer (`captain.last_line`, written when a turn settles) and its age; `+` creates, `···` renames the leader. The list refreshes when the open chat's turn changes, on focus and after edits; there is no timer.
- **Delete** archives the captain and its chat (nothing is destroyed) and frees the name and the place.

## Cost estimate at 100 power users

Assume 3 captains each and about 25 real captain turns a day per user (a captain is woken less than Y²'s 83 real turns a day). These are extrapolations from the Y² measurements in docs/y.md, not measurements; measure the crew's real duration per wake before turning step 3 on widely.

| Item | Added |
|---|---|
| Idle captain | 0 (a row) |
| Model turns | about 7,500 a day on the people's own plans; the ceiling is unchanged (the per-user cap is shared with Y²) |
| Crew Durable Object requests | 0 in steps 1 and 2 (captains are not noted); step 3 adds one wake per owned-thread event, the same shape as Y²'s |
| Durable Object duration | the captain's own chat object runs only during its turns, like any chat (up to about 28k GB-s a month at 1 s per turn, upper bound) |
| Worker requests | about 0.3 M a month (sidebar reads on focus and on turn changes) |
| Supabase | one small indexed read per sidebar refresh and per turn (`projectYMode`) |

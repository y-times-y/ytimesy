# Y² (Super agent) vs Capy's Captain: UX study and redesign

2026-11-24. Research and design. Only the prompt-level change in section 6 is built; nothing is deployed. Prototype: the canvas "Y² Captain UX" (not committed).

## 1. What Capy's Captain does (sourced)

Read in full: [Captains docs](https://docs.capy.ai/captains), [Captains feature page](https://capy.ai/features/captains), [Background work](https://docs.capy.ai/async-work), [Capy changelog](https://capy.ai/changelog). Read the first 100k of 524k characters of [llms-full.txt](https://capy.ai/llms-full.txt) (the bug-backlog and code-migration guides). Search snippets only (not opened): [paralect.com](https://www.paralect.com/stack/capy).

- **Shape.** A long-lived agent that starts threads (its "crew"), hears from each "each time that thread finishes a turn or needs something", and "tells you only what needs you". Each crew thread opens beside the Captain's chat; the Captain "updates its plan without repeating them to you".
- **Digest = the reporting unit.** Three sections, **Needs you / New / In progress**, rewritten "when the crew's state changes", kept in `DIGEST.md` in the Captain's Drive. The Overview shows the first five Needs-you items above the thread list. "When a report changes the digest, the Captain pastes its Needs you section into the chat." It tags the person when a decision or blocker is theirs; the tag notifies like any mention. The layout is changeable by telling the Captain ("add a Shipped this week section"); it saves that as a rule.
- **Answering.** One-line replies in the Captain chat: "merge capy#3780", "hold the migration until Monday"; the Captain "acts on it and drops the item". Guardrails are rules in its `AGENTS.md` ("Nothing merges without my word", "Ask before starting more than two threads at once"). Capy never merges unless asked.
- **Questions from crew threads.** The docs still say "If a crew thread asked you directly, answer in that thread." But changelog 0.9.0 (Nov 15): "A Captain's chat gathers its crew's open questions in one menu, with Dismiss all", and each sidebar row "shows the question a Captain is waiting on you for, or the newest message it sent". 0.4.2: "When a crew thread answers you directly, its Captain now hears what happened." 0.7.0: "A request stays open until you answer it, and the thread keeps one line for it that reopens it."
- **Captains verify, not trust.** "Our coordinating Captains verify from their own reads, never from a thread's claim that something is done" (CI, review, mergeability at the head commit). Decisions not in the brief are brought "with the choices written out instead of guessing".
- **Failures.** No dedicated section. Provider errors: "the error card offers Retry" (0.5.0, 0.4.7), the thread "shows the provider's reason and when to retry" (0.9.0), a thread out of credits "pauses instead of failing" (0.9.2), a thread waiting on a used-up subscription retries when it resets (0.6.0). A failing CI check wakes the PR's owning thread, which pushes a fix. Blockers become Needs-you items.
- **Notifications.** Desktop notification when a thread finishes or needs you (0.2.2), browser push (0.4.2), unread-mention badge (0.4.4), Slack DM when a PR merges (0.9.0), Slack `captain=<name>` routing. Needs-you badge clears when you reply (0.4.2).
- **Automations / check-ins.** Ask the Captain for a schedule ("weekdays at 9am check PRs and update the digest"); automations can also feed it tickets.
- **Messaging a working thread.** Steer (after the current step), Queue (after the turn), Interrupt (right away); Slack/API interrupt by default ([Background work](https://docs.capy.ai/async-work)).
- **Sidebar.** 0.9.1: "Captains and threads in one sidebar".

**Not verified** (say so, do not guess): what the Captain chat looks like (no screenshot or video was reachable through the text fetch); whether the 0.9.0 crew-questions menu lets you answer inline or only jumps to the thread; the wording or length of Captain messages; whether a Captain auto-retries or archives failed threads on its own (docs only show it acting on rules you give); push notification contents.

## 2. Audit of Y² (code and production, read-only)

Code: `src/domain/y-squared.ts` (instructions, tools), `src/domain/y-squared-crew.ts` (wake body), `docs/y.md`, `src/features/sessions/{user-question,secret-request,push-approval}-card.tsx`.

**What a wake carries.** Titles, thread events ("finished its turn (detail)", "needs the person", "failed"), still-working threads with minutes, stall signals, schedules. No question text, no options, no reply. Y² must call `threads` then `thread` per changed thread to learn anything.

**What Y² can do without the person opening a thread.**

| Need | Today |
|---|---|
| Read status, last reply, canvases | yes (`threads`, `thread`, `read_canvas`, `show_canvas`, `view_image`) |
| Start / message (queue, steer, interrupt) / stop | yes |
| Answer a thread's `ask_user` question | only by `message_thread` text; the card in the thread stays open |
| Provide a secret | no. The secret card saves through the project server function (`saveProjectSecretFn`), not the thread, so an inline field is feasible without the model; Y² cannot show it |
| Approve a push or a plan | no |
| Retry a failed thread | by writing a message (instructions allow it) |
| Archive or clean up failed/obsolete threads | no tool |
| Merge a PR, deploy | no (and deliberately escalated) |
| Know a PR's CI/merge state | no (documented gap in docs/y.md) |

**Instruction contradictions found.** `ySquaredInstructions` said both "at most 5 short lines" and "Report in at most 100 words (about 100 for each thread you report on)", and also told Y² to "report the SUBSTANCE" of every finished thread; the wake text added "Never just say it finished; do not list everything again" and the same "short delta with the substance". The model resolved this toward long. Also: "Never repeat a reminder" is only in the proactive section and has no memory behind it; Y² sees only the Y² chat's own history, not what is still open.

**Production, last 3 days** (the only Y² chat, one project; read-only transaction, counts only, no content kept):

- 389 wake messages (~130/day), 19 messages typed by the person. 111 of the wakes were heartbeat-only ("Still working" with no new event).
- Every wake got a reply: 212 (55%) were `NOTHING_TO_REPORT` (silent but a full model turn each), 177 (45%) were spoken.
- Spoken replies: median 63 words, p90 299, max 536; 72 of 181 over 100 words, 50 over 200; 4 contain tables, 49 contain bullet lists, 17 re-mention old open items ("still open/waiting/outstanding"). Mean words in the reply right after a wake: 117; 61 of 177 over 100.
- Threads in the project: 32 completed, 7 failed (5 not touched for 3+ days), 5 idle, 4 more idle with status `starting` (all 3+ days old), 1 running. Nothing cleans them up.
- The Y² chat holds 25 question cards and 158 tool-call items naming ask_user/start/message/stop_thread in 3 days (a text match on the stored items, so approximate).

### Why it is hard to live in, ranked by user impact

1. **The answer UI lives in the thread.** Questions, secrets, push and plan approvals are cards in the thread's chat; Y² can only relay in words, then write the answer back as text. This is the exact complaint ("I still have to go to these threads").
2. **Too many long messages.** ~130 wakes a day, 45% spoken, a third over 100 words, with tables, bullets and repeated old decisions; contradictory length rules in the prompt. Nothing is "the one thing to look at".
3. **No standing "needs you" list in the chat.** The status card is a link list (title, request, elapsed); it shows no question or options and cannot answer. A needs-you item reported once scrolls away.
4. **Thin visibility.** Truncated last reply, no CI/PR state, canvases only recently readable; Y² can describe, not show, a thread's result inline (only canvases via `show_canvas`).
5. **Failures are noticed late and never cleaned.** 7 failed and 4 stuck-`starting` threads sit there; no archive/retry tool; stall signals fire per wake.
6. **Identity.** Wrong thread links when titles were missing (partly fixed 2026-11-23); links by title only, no `<project>-<number>` handle in messages.
7. **Wake cost with no value.** 212 silent model turns in 3 days (plan usage, Cloudflare DO alarms) for nothing shown.

## 3. Target experience (pain -> fix)

| Pain | Fix | Kind |
|---|---|---|
| Long, repeated messages | One rule: <=60 words, needs-you first, one decision per message, no tables, no repeats, grouped finishes, a 10-line digest only on request or schedule | prompt (done, section 6) |
| Silent turns | Do not wake the model for heartbeat-only and routine finishes: the server builds the crew's wake and skips it when nothing is new and no follow-up signal exists; batch finishes inside a debounce window (e.g. 60 s) | server, small |
| Needs-you scrolls away | A pinned "Needs you" inbox in the Y² chat (extends the status card): one row per open item with its real question, options and controls; rows disappear when answered | UI + data |
| Must open thread to answer | Inline controls: question buttons, secret field, push/plan approve, retry, stop. Answer is posted to the thread by the server as the person's own message/answer (same path as the thread's card), never through Y²'s model | tools + UI |
| Secrets | Inline secret field calls the existing `saveProjectSecretFn`; the value never enters Y²'s context, transcript or logs; Y² sees only "secret NAME saved" | UI (reuses fn) |
| Can't see results | Result preview card: thread name, one-line outcome, PR chip with CI state, canvas thumbnail (`show_canvas`), "Open thread" as a pointer | UI; PR state needs a webhook note into the crew |
| Failed/stalled threads | Automatic: transient failure -> retry once with a one-line note; failed twice -> a Needs-you row; stalled -> existing steer; failed threads older than N days with no PR -> archive and say "archived 5 old failed threads" | tools (`retry_thread`, `archive_thread`) + prompt |
| Identity | Every mention is `<project>-<number>` plus title as a real link; crew rows carry the number | prompt now (title), number needs data |
| Coexist with the sidebar | Sidebar groups (Needs you / Working / Recently finished) are the cross-project view; the Y² inbox is the same list with controls for this project. Same source of truth (`['agent-sessions', projectId]` plus the crew card read), no second poll | UI |
| Digest | `NOTHING_TO_REPORT` by default; a scheduled "morning digest" (already possible with `schedule`), Needs you / Done / Working, <=10 lines | prompt (done) + schedule |
| Threads talk to each other | Separate approval; not part of this design | - |

### New tools (need the user's approval)

- `answer_thread_question(id, answers)` / UI-only: the inbox answer posts the same payload the thread's card posts. Prefer UI-direct (no model hop, no tokens); a model tool only for "answer yes to all of those".
- `provide_secret`: no model tool at all. UI-only, calling `saveProjectSecretFn`. Y² is told the name only.
- `approve_push(id)` / `approve_plan(id)`: UI buttons; model gets only the result. Merge/deploy stay a person's click.
- `retry_thread(id)`, `archive_thread(id)`: model tools with a hard rule: retry once per cause, archive only failed/idle threads with no open PR and older than 3 days; each prints one line.
- Wake payload enrichment: put the question text and options, the secret names and the PR URL in the crew row (already in the chat object, no DB read) so Y² and the inbox need no `thread` call: fewer tool steps per wake.

### Cost notes

No new alarm or poll. Inbox data = the crew card read already done per status change (1 DO request). Fewer model turns: skipping heartbeat-only and batching finishes cuts the 212 silent turns. Inline answers save a Y² model turn each. Supabase egress: inbox reads the crew rows only; previews reuse `show_canvas`'s lazy item read.

## 4. Build order

1. **Now (done, prompt only).** Section 6.
2. **Next (small server work, no UI).** Skip no-op wakes server-side; batch finishes; enrich the crew note with question text/options/secret names/PR URL; `retry_thread`, `archive_thread` tools.
3. **After (UI).** Needs-you inbox with inline controls in the Y² chat (extends the status card); result preview cards; PR state via webhook into the crew.
4. **Later.** Threads talking to each other (separate approval); Captain-style rules file the person edits by chat ("nothing merges without my word", "ask before more than 2 threads").

## 5. Questions for the user (with recommendations)

1. Inline answers go straight to the thread from the UI (no model) or through Y²? Recommend UI-direct: cheaper, instant, and secrets never touch the model.
2. May Y² auto-retry once and archive old failed threads (tools `retry_thread`, `archive_thread`)? Recommend yes, with the one-line note and a "failed twice = needs you" rule.
3. Skip model wakes when nothing is new (server-side)? Recommend yes; keep the heartbeat only as a stall check.
4. A scheduled morning digest by default (9:00 local) or only on request? Recommend on request first; offer it once.
5. Add `<project>-<number>` to crew rows and links? Recommend yes (small data change).

## 6. What was built (prompt level, committed locally, not deployed)

`ySquaredInstructions` and `crewWakeBody`: one length rule (<=60 words in all, replacing "5 lines" vs "100 words per thread"), no tables or more than 3 bullets unless asked, one decision per message with a recommendation and a count of the rest, never re-report/restate/recall resolved or old items unless changed or asked, finished threads grouped in one line, a <=10-line digest in three groups only on request or schedule, quiet when nothing changed. Tests: `src/domain/y-squared.test.ts` ("Y² reports briefly and quietly"). Live check: `scripts/y-squared-behaviour-check.ts` gained a "busy wake" scenario (Opus 5.5, tools simulated): 3 runs, all busy-wake checks 3/3 (<=70 words, no table, <=1 question, leads with what needs the person); the one miss was a wording check ("reproduce"), loosened. Whether the public harness (`y-times-y/harness`) carries Y² was not checked; no port was made.

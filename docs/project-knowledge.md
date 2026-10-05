# Shared project knowledge

The active cloud API and Codex subscription loop loads owner-scoped project
knowledge before inference, without starting a VM. Markdown is stored in the
existing PostgreSQL `project_briefing.text` column, not committed into a user's
repository. No new schema, embeddings, or graph service are required.

Non-competing leads have `remember_project`: replace a named entry containing a
capability/decision, source pointers, and an explicitly agent-reported status.
Writes lock the project row, preserve unrelated entries and legacy briefings,
redact known credential patterns, and reject document overflow rather than
silently deleting older facts. The document is bounded to 12,000 characters;
leads must condense existing entries when it fills. This is a best-effort secret
filter, not permission to store sensitive material.

Every cloud turn, including followups and durable workflow steps, reloads the
document. It is supplied separately from compactable conversation history in
model instructions, labeled as untrusted historical data. Current source code,
repository instructions and the user's request remain authoritative. Agents
must search source pointers before proposing duplicate implementation or
treating a prior report as deployed/merged work.

Root chats also receive up to four selected recent root reports, labeled as
reports rather than verified facts. Successful non-competing root turns record
one idempotent report per turn; failures/cancellations do not. Reports do not
replace maintained Markdown. If this optional report write fails, a completed
turn remains completed and the server logs a generic warning; no retry outbox
is implemented for this secondary write.

Children receive up to four keyword-matched maintained entries. They do not
inherit parent transcripts, arbitrary legacy briefing text, or sibling reports,
and cannot write shared knowledge. They report findings to their lead. Competing
leads cannot publish shared entries/reports before their work is selected.

This does not import every historical chat, verify model assertions, detect all
stale facts automatically, or require a model to use its memory tool. Completed
reports provide a basic automatic fallback; curated entries require tool use.
Existing native adapters retain their separate legacy context path. The old
six-line rolling briefing writer was removed so it cannot truncate maintained
knowledge.

## Verification — 2026-10-04

Targeted tests cover Markdown replacement/retention, relevant child filtering,
owner-scoped SQL against disposable PGlite, overflow rollback, known-secret
redaction, idempotent completion reports, both cloud API and subscription
dispatch, and retention of supplied knowledge through real SDK compaction with
mocked providers. Related session/delegation regressions passed as well.

The existing development worker was redeployed with no queued/running model
turns and no new VM or schema migration. A read executed on that worker loaded
3,352 characters for an existing project and returned empty context for an
unrelated owner. The deployed cloud-loop source was independently checked for
the new loader. This is live deployment/database proof, not a live provider
memory-write or end-to-end model behavior test. No paid inference was launched.

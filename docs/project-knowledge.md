# Shared project knowledge

The active cloud API and Codex subscription loop loads owner-scoped project
knowledge before inference, without starting a VM. Markdown is stored in the
existing PostgreSQL `project_briefing.text` column, not committed into a user's
repository. Revision history is stored in the private `project_memory_revision`
table. No embeddings, separate Git remote, or graph service are required.

Non-competing leads have `remember_project`: replace a named entry containing a
capability/decision, source pointers, and an explicitly agent-reported status.
Writes lock the project row, preserve unrelated entries and legacy briefings,
redact known credential patterns, and reject document overflow rather than
silently deleting older facts. The store is bounded to 120,000 characters;
the startup index plus relevant notes are bounded to 10,000 characters, with
recent reports supplied separately. Leads must condense existing entries when
storage fills. This is a best-effort secret
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

Children receive a bounded topic-title index plus up to four ranked lexical matches.
The index lets them discover existing capabilities even when their task's wording
does not match a note. Titles are not proof; full notes and source checks remain
necessary. They do not
inherit parent transcripts, arbitrary legacy briefing text, or sibling reports,
and cannot write shared knowledge. They report findings to their lead. Competing
leads cannot publish shared entries/reports before their work is selected.

This does not import every historical chat, verify model assertions, detect all
stale facts automatically, or require a model to use its memory tool. Completed
reports provide a basic automatic fallback; curated entries require tool use.
Existing native adapters retain their separate legacy context path. The old
six-line rolling briefing writer was removed so it cannot truncate maintained
knowledge.

## Indexed memory and consolidation — 2026-10-05

New chats receive a compact topic index; `search_project_memory` searches all
maintained topics and paginates results. `read_project_memory` retrieves a complete
topic and follows virtual `[[memory/key]]` references. These are not checkout files.
Both tools work without a VM and are core tools, available without discovery.
Source paths and revision/file-hash evidence remain attached to the notes.
`inspect_project_evidence` still checks freshness, not truth or test success.

`remember_project` requires the document revision returned by read/search.
`consolidate_project_memory` atomically updates up to sixteen distinct topics or
removes obsolete ones under the same revision fence and project row lock. A stale
agent must reread before writing. Removing a linked topic requires updating its
links in the same operation. Failed changes roll back both notes and history.
Children and competing leads can read but cannot publish shared notes.

Each changed topic retains its previous/next Markdown, originating session,
timestamp, operation and document hash in a private owner-scoped history table.
`read_project_memory_history` lists bounded previews; a revision ID retrieves
the complete historical note. No history is automatically executed or restored.
Project deletion cascades to its memory and history. History starts at rollout;
pre-existing edits are not reconstructed.

Duplicate/near-capacity signals recommend maintenance during a normal lead turn;
lead instructions also call for consolidation when findings contradict old notes.
This matches the consolidation capability without installing upstream code or
launching a separate paid "dreaming" agent. It does not guarantee model compliance,
detect semantic duplicates automatically, or sweep inactive projects on a timer.

Verification: 1,343 tests passed, three skipped; typecheck, lint, build and
`git diff --check` passed. A full run concurrent with the build timed out one
unrelated Git-broker test; that test passed alone and the complete suite passed
again without concurrent build contention. Development migration applied.
`node --env-file=.env --import tsx scripts/prove-project-memory.ts --live`
verified cross-chat index/search/read, revision history, consolidation, rejected
stale writes and owner isolation through the real service/database path. Disposable
database fixtures were removed; existing project notes were untouched. No model
inference or VMs were started. This is not a live model-behavior benchmark or a
deployed persistent worker; the previous disposable-only hosting decision remains.

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

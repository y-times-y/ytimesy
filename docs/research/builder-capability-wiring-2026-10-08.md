# Builder capability wiring

This follow-up fixes integration gaps before another model-performance run.
It does not establish superiority over Codex or remove all model/environment
constraints. No paid inference, VM allocation, deployment or migration was run.

## Changes

| Previously observed limitation | Change |
| --- | --- |
| Indexed search required an unset opt-in flag | Enabled by default; explicit `YTIMESY_INDEXED_SEARCH_ENABLED=0` opts out. Unsupported queries bypass Python; missing Python, incompatible SQLite, small/oversized corpora and failed refreshes use Git. |
| Builders needed discovery to find language inspection | `inspect_code` and `inspect_code_batch` are immediately visible. Shared model instructions explicitly describe LSP operations and missing-server recovery. |
| Small exact edits required another discovery request | `replace_text` is immediately visible for all model families; other edit aliases remain deferred when the batch editor is present. |
| Builders saw only keyword-matched memory bodies | They also receive the bounded topic-title index. Full memory reads are immediately visible. Unrelated note bodies, parent transcripts and sibling reports stay excluded. |
| Builder-only evaluation omitted production context callbacks | It now reuses automatic scoped guidance, source freshness, post-compaction restoration, encrypted archival and the same archive read/search tools as production. |
| Compaction could evade the evaluator's request guard | Native subscription compaction now uses the guarded model transport. |

## What project memory does

Owner/project-scoped Markdown lives in PostgreSQL `project_briefing.text`.
Named notes record capabilities, decisions, paths, agent-reported verification
and optional source hashes. Revision history preserves changes. The store is
bounded to 120,000 characters; startup knowledge is bounded to 10,000.

Leads curate reusable facts with revision-fenced memory tools; successful root
turns also save separate historical reports. Builders can discover and read
notes but cannot publish them. Memory stays outside compactable conversation
history, so compaction does not erase it. Source hashes establish freshness,
not correctness; current checkout inspection remains mandatory. A title index
reduces exact-keyword dependence but does not constitute semantic search.

## Remaining constraints and remedies

- Language intelligence needs a supported language and working server/compiler.
  Use existing `prepare_code_tools` for supported pinned servers, then retry;
  otherwise use direct source/search/checks and report unavailable analysis.
  Never equate missing diagnostics with success.
- Lexical search cannot reliably resolve conceptual synonyms. Agents can search
  alternative symbols/phrases and inspect source structure now. Semantic indexing
  remains a separate, measured retrieval change, not something this patch adds.
- Memory is not automatically a complete or truthful repository map. Topic
  discovery, source verification and lead-maintained updates mitigate duplication;
  a stronger automatic capability map needs its own freshness and recall tests.
- Active current-task evidence can still grow. Existing artifacts, superseded-read
  retirement and native compaction preserve recovery, but a task-aware relevance
  controller is not implemented here. Do not hide current evidence merely to
  improve token counts; any future retirement must retain exact recovery and
  demonstrate correctness on protected tasks.
- Visibility and prompts cannot force sound model decisions or guarantee speed.
  Local contracts must pass first; model outcomes require private, frozen-task
  evaluation with actual checks, request/token accounting and resource cleanup.

The builder-only evaluator intentionally does not inject product-project memory
into benchmark tasks, run a leader, publish changes or reproduce the production
queue. Its context callbacks now match the source/guidance/archive mechanisms;
that is not a claim of full production lifecycle parity.

## Local verification

New regressions failed before the changes, then passed. The targeted capability,
memory, archive and context suite passed 105 tests across 15 files. Application
and workflow typechecks, changed-file Biome and `git diff --check` passed.
Live language-server availability, archive round trips and model compliance
were not retested in this follow-up.

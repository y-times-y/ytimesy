# Agent Memory Repo assessment

Checked 2026-10-05 against the four upstream files linked below, including their raw contents through agent-browser. These are moving `main` references; no upstream commit was pinned. This was document inspection, not an installation, benchmark, or live multi-VM test. No user memory was changed.

## License

The repository uses MIT, copyright 2026 AgentMemoryRepo. Commercial use, modification, distribution, sublicensing, and sale are permitted. Copies or substantial portions must retain the copyright and permission notice; the software has no warranty. Preserve the full license when incorporating upstream material. [LICENSE](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/LICENSE)

## What exists

The file-format spec defines a separate Git repository with a required root `MEMORY.md`, a short shared-context section, an `## Index` of topic links, single-line bullet entries, optional metadata, and root-relative `[[path]]` links. `source` and `added` are recommended metadata, not mandatory fields. This is a human-readable index and linked notes; it does not specify embeddings, a search service, or an automatic freshness validator. [SPEC](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/SPEC.md)

The supplied skill instructs an invoked agent to read `MEMORY.md`, grep or follow links, update notes, and commit intended changes. It treats memory as context rather than executable instructions, excludes credentials, and requires a clean worktree before updates. It explicitly provides no hooks, scheduled jobs, startup scripts, or automatic later-session loading. [Skill](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/skills/agent-memory-repo/SKILL.md)

The README describes a broader clone/read/update/commit loop and periodic “dreaming” to discover patterns, merge duplicates, remove obsolete entries, and check sources. That description is a workflow concept; the inspected skill does not implement its scheduler or dedicated agent. The README's two-session trial is local to the same machine and storage. [README](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/README.md)

## Hosted and concurrent use

Fresh machines need a user-owned private remote and a clone; local storage alone cannot carry memory across them. Existing clones use `pull --ff-only`; divergence stops the skill rather than triggering automatic merging. Push requires an explicit sync request. Unrelated changes appearing during an update also stop the commit. [Skill](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/skills/agent-memory-repo/SKILL.md)

The README presents parallel agents and Git conflict surfacing as a use case. Inference: a hosted harness still needs ownership/access enforcement, clone lifecycle, write isolation or serialization, and a merge/retry policy. The inspected skill supplies no distributed locking or parallel reconciliation protocol. [README](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/README.md), [Skill](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/skills/agent-memory-repo/SKILL.md)

## Assessment

Inference: the reusable pieces are the file convention, linked retrieval, optional provenance, and Git history. Retain our existing source and commit freshness checks: a source URL or Git commit records provenance/history but does not establish that a recalled fact is still current. The upstream spec recommends metadata and updating obsolete entries without defining those checks. [SPEC](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/SPEC.md)

No retrieval-accuracy, token-cost, latency, or agent-success benchmark appears in these four inspected primary sources. Their worked examples and local trial do not establish production improvement. [README](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/README.md), [SPEC](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/SPEC.md), [Skill](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/skills/agent-memory-repo/SKILL.md)

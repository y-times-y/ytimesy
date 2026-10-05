# Cursor project context: confirmed mechanisms

Verified 2026-10-04 with `agent-browser read` against current first-party documentation. Documentation verification only; no authenticated Cursor session or internal implementation was inspected.

## Answer

Cursor's current **Projects** feature documents persistent shared files and a coordinator agent. It does not document a knowledge graph. The public docs do not establish that those shared files are specifically Markdown or disclose their filenames, storage backend, retrieval algorithm, or injection rules. Ordinary chats, Projects, automation memories, and codebase indexes are distinct mechanisms.

| Surface | Confirmed persistence/context mechanism | What remains unknown |
| --- | --- | --- |
| Project | A coordinator plans and delegates to agents. A set of shared files syncs across every cloud and local machine used by its agents. Agents add research, artifacts, codebase learnings, and working preferences; future agents can reuse them. The Project maintains context over months. | File format and paths, database/storage backend, summarization and retrieval policy, context selection, and whether any graph exists internally. |
| Ordinary Agent chat | Instructions, tools, and model compose Agent. Rules supply reusable prompt context. The Agents Window can search past transcripts using a local search index. | No claim in the inspected pages that every fresh ordinary chat automatically receives all earlier chat history or inherits a Project's shared context. |
| Automation | Read/write persistent named memory entries across runs of the **same automation**. Default entry name is `MEMORIES.md`; entries exist outside the working filesystem, are enabled by default, and are viewable/editable/deletable through tool configuration. | Physical storage format and backend; no documented global memory shared with all chats or all automations. |
| Repository rules | `.cursor/rules/*.mdc` and plain `AGENTS.md` supply persistent instructions included at the start of model context when applied. Rule selection can be automatic, scoped, relevance-based, or manual. | These are instruction mechanisms, not proof of automatically learned conversation memory. |
| Codebase search | Merkle trees track file changes; files are split into syntactic chunks and embedded for semantic search; embeddings are cached by chunk content. Simhash/vector search finds a reusable codebase index; content proofs filter copied-index results. | This article does not describe chat-memory storage or a semantic knowledge graph of project decisions. |

Sources: [Projects](https://cursor.com/docs/agent/projects), [Agent overview](https://cursor.com/docs/agent/overview), [Automation memories](https://cursor.com/docs/cloud-agent/automations#memories), [Rules](https://cursor.com/docs/rules), [Secure codebase indexing, January 27, 2026](https://cursor.com/blog/secure-codebase-indexing).

## Important distinctions

- **Project means the dedicated coordinator product**, not merely a repository opened in Cursor. It runs on Cloud Agents, can dispatch local testing agents, and can subscribe to external events or schedules. The shared-context claim applies to agents inside that Project. [Projects](https://cursor.com/docs/agent/projects)
- **`MEMORIES.md` is a named automation entry, not necessarily a repository file.** Calling it a regular file committed alongside the code would contradict the documented filesystem boundary. [Automations](https://cursor.com/docs/cloud-agent/automations#memories)
- **Markdown support is directly documented for `AGENTS.md`; Project Rules require `.mdc`.** A plain `.md` placed under `.cursor/rules` is ignored. These names do not establish the format of Project shared files. [Rules](https://cursor.com/docs/rules)
- **A Merkle tree is a synchronization structure.** The indexing article documents semantic code retrieval through embeddings, not persistent learned-memory relationships. Inferring a memory graph from the presence of a tree/vector database would conflate indexing with memory. [Indexing](https://cursor.com/blog/secure-codebase-indexing)
- **Historical 2025 sidecar-memory descriptions are not current proof.** This check did not reverify that older feature or establish whether it still exists, was replaced, or shares infrastructure with Projects. Do not use an old sidecar proposal/review flow to explain current Projects without fresh evidence.

Practical interpretation: new tasks **inside a Project** can benefit from synchronized files its agents accumulated. A new independent chat can receive rules and search/read repository context, but the inspected docs do not promise automatic inheritance of another chat's accumulated decisions. The verified answer is file-based shared Project context; the complete internal implementation remains undisclosed.

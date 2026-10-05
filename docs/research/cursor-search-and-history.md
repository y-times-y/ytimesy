# Cursor search and conversation recovery

Verified 2026-10-04 against Cursor's public primary sources. Research only;
no retrieval implementation or architecture change is accepted by this note.

## Current code search differs from the older semantic index

Cursor's current [Search documentation](https://cursor.com/docs/agent/tools/search)
describes Instant Grep: local indexed text search with regex and word-boundary
matching. It explicitly says Cursor does not upload file paths or code to build
this index and does not store codebase embeddings for search. Opening a match
can still send its content in a model request. The same page describes an
Explore subagent running parallel searches in its own context and returning
findings to the main agent.

In a [July 22, 2026 staff response](https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899/10),
Colin says semantic/embedding indexing is being turned down in favor of grep
retrieval. For concept queries without known identifiers, the agent searches
multiple candidate terms, lists directories, reads files, and refines its search.
This is an agent choosing lexical queries based on meaning; it does not require
an embedding index.

The [January 27, 2026 indexing article](https://cursor.com/blog/secure-codebase-indexing)
documents the earlier architecture: syntax-based chunks, embeddings cached by
content, Merkle-tree synchronization, and secured teammate-index reuse. It
reports a 12.5% average accuracy improvement in a particular evaluation.
That is dated code-search evidence, not a chat-history benchmark or a reliable
description of the current default. Some older Cursor pages still mention
semantic search; prefer the current Search documentation and dated transition
statement when describing today's documented behavior.

## Recovery after compaction and searching other chats are distinct

The [January 6, 2026 dynamic-context article](https://cursor.com/blog/dynamic-context-discovery)
explains that summarization is lossy. Cursor gives the agent a reference to a
chat-history file after automatic or manual summarization so it can search the
original history for missing details. This establishes retained history with
on-demand retrieval. It does not specify embedding-based history search,
ranking algorithms, or recovery of hidden reasoning that was never retained.

Separately, the current [Conversation search help](https://prod.cursor.com/help/ai-features/conversation-search)
documents a user-facing local index across thousands of past conversations in
the Agents Window, plus search within an open conversation. It does not state
that this index uses embeddings or that the agent automatically queries other
conversations after compaction. These capabilities should not be conflated.

## Implication for ytimesy's archive search

PLAN.md describes encrypted, owner-authorized keyword search over retained
conversation archives, with retrieval of original message pointers. Cursor's
documented compaction recovery supports that basic separation: a compact
active context can retrieve evidence from a retained transcript.

Semantic retrieval could help when a question paraphrases the archived wording,
such as querying "why was sharing machines rejected?" against a message saying
"writers need isolated execution VMs." That is a hypothesis for our corpus;
Cursor's historical code-search evaluation does not prove it improves our chat
search. Exact paths, error strings, IDs, and quotations still benefit from
lexical matching.

Before adding embeddings, evaluate ranked lexical results, several query
variants, and retrieval of the surrounding turn rather than an isolated matching
message. Compare these with a hybrid semantic/lexical candidate on actual
archive questions, measuring answer correctness, evidence recall, latency,
cost, and owner/chat isolation. Retain original message pointers for verification
under either approach. No claim is made that semantic chat retrieval is an
unclaimed product intersection.

Verification: current Search documentation was opened and read in agent-browser.
Other sources were fetched from their official pages. This is documentation
verification, not a live Cursor agent run or a measured ytimesy retrieval test.

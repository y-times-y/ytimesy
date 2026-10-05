# Cursor compaction and history retrieval

Checked 2026-10-04 against official Cursor publications. This is published design evidence, not a live test of Cursor's agent behavior.

Cursor has implemented practical ways to reduce information loss. Its publications do not establish lossless compaction or guaranteed recovery of every forgotten constraint.

## Searchable history outside the active context

Cursor summarizes when its context window fills, and supports manual `/summarize`. [Cursor 1.6 changelog, September 12, 2025](https://cursor.com/changelog/1-6).

After automatic or manual summarization, Cursor supplies a reference to a chat-history file. The agent can search that history for details missing from the summary. Cursor explicitly acknowledges that summarization is lossy; retrieval supplies a recovery path when the agent recognizes a need for more detail. [Dynamic context discovery, January 6, 2026](https://cursor.com/blog/dynamic-context-discovery).

The same general harness approach writes long tool responses to files for selective reading, syncs integrated terminal output to files, and loads skills and MCP descriptions when needed. These mechanisms reduce how much information must occupy the active window. The reported 46.9% token reduction concerns the MCP-discovery experiment, not a measurement of history-retrieval accuracy. [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery).

## Composer also learns what to preserve

Cursor's Composer model is trained with compaction inside reinforcement-learning trajectories. At a fixed token trigger, Cursor inserts a summarization request; Composer produces a summary, then continues with that summary and conversation state, including plans and remaining tasks. The final task reward also trains the summaries that enabled completion. [Training Composer for longer horizons, March 17, 2026](https://cursor.com/blog/self-summarization).

Cursor reports approximately 1,000-token summaries versus over 5,000 for its prompt-based baseline, and a 50% reduction in compaction error on its tested tasks at 40k and 80k triggers. These are Cursor's reported evaluations, not guarantees for every task. This training technique is specific to Composer; the publication does not establish equivalent training for third-party frontier models selected in Cursor. [Training Composer for longer horizons](https://cursor.com/blog/self-summarization).

## What remains unknown

The cited history-file description does not specify a complete archive schema, retention guarantees, whether every original tool payload is retained, or a mechanism guaranteeing that the agent notices information missing from its summary. These details remain unverified. A searchable archive can preserve accessible evidence while the active summary remains lossy.

Cursor's April 30, 2026 harness article reinforces its move toward dynamic retrieval and reports that using a more expensive summarization model produced negligible quality improvement in one experiment. That supports evaluating the entire retrieval-and-compaction workflow, rather than assuming a stronger summarizer alone fixes forgetting. [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness).

Verification: the January article was read in an isolated agent-browser session; official web fetches supplied the March and April articles and changelog. No application code changed.

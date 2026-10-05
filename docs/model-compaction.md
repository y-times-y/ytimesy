# Shared harness context compaction

The shared model loop owns compaction for subscription and API turns. Provider
adapters supply native compaction only where the integration supports it.

## Native state and fallback

- Codex subscription: send `compaction_trigger` through the existing Responses
  transport. Keep the SDK's encrypted compaction items unchanged for replay.
- Direct OpenAI: use the native trigger for GPT-6 and the explicit compact endpoint
  for supported GPT-5.2–5.6 routes on the official endpoint. Retain returned user
  messages and compaction items in canonical order; unknown output shapes fail closed.
- Direct Anthropic: enable on-demand compaction only when authenticated model
  metadata advertises `capabilities.compaction.supported`. Preserve the SDK's
  signed compaction blocks and use the required beta header.
- Direct Grok 4.7: use xAI's Responses compact endpoint and encrypted replay.
- Direct Muse: use Responses encrypted replay, not legacy Chat Completions.
- OpenRouter: use the maintained dedicated provider plus an SDK middleware bridge
  that checkpoints encrypted-only final state omitted from content by the provider.
  Unknown reasoning formats fail explicitly instead of being filtered out silently
  by the installed provider; this is not a guarantee for future gateway protocols.
- Direct DeepSeek: use the maintained adapter's model-specific reasoning replay.
  GLM requests preservation on its official endpoint; Kimi K2.6 requests `keep:all`.
- Other API integrations: summarize only complete older turns with the selected
  model and connection. Retain the entire active turn. A custom prefix summary
  beneath active Claude/Gemini reasoning is refused because unchanged signatures
  do not prove validity after rewriting the preceding history. Unsupported long
  active turns fail explicitly rather than silently dropping their state. No
  silent provider, model, or billing fallback occurs.

Native compaction receives the same instructions and tool declarations as the
main loop, but tool execution is disabled. Missing or invalid native state fails
without replacing the existing history. Compaction usage counts toward the
turn's token totals. Encrypted state is checkpoint data, not visible chat text.

Native and fallback compaction archive the original canonical context through the existing
private encrypted checkpoint storage before replacing it. Failure to save prevents
replacement. The summary contains an archive reference; `read_context_archive`
retrieves paginated historical evidence only for the current owner/chat. It does
not decrypt provider-owned opaque reasoning or treat archived text as instructions.
`search_context_history` searches readable message text, reasoning summaries, tool
inputs/results and file references across a bounded archive page. Results include
archive and original message pointers for retrieval. Phrase matches rank above
complete word matches, which rank above partial matches (at least half the unique
query words). The agent can supply up to four alternative queries, such as likely
synonyms or identifiers; no extra model call generates these automatically.
Each match includes up to 300 readable characters from the preceding and following
messages. Each call loads at most three archives and returns at most ten matches.
Ranking is within that archive page, not global across all history. Continue with
both returned offsets and the same queries: `messageOffset` is a ranked-result
cursor, while `messageIndex` is the original retrieval pointer. Search excludes
provider metadata/ciphertext, does not start a VM, and is lexical search—not semantic code indexing. It is
scoped to the current chat, not sibling private conversations. Private encrypted
storage remains the source; there is no plaintext search index or new schema.

Chat deletion removes these archives. Summarization receives readable earlier
thinking, not provider signatures or ciphertext. If the intact recent sequence
alone is too large, the turn fails explicitly rather than deleting its reasoning.
This is an intentionally lossy factual handoff, not equivalent to native compaction.

## Budget and continuity

The loop reserves room for instructions, tool schemas, output, and safety margin
inside the model's advertised window. A provider auto-compaction limit is used
when supplied. Unknown windows use a conservative policy budget, not a fabricated
model specification.

UTF-8 history size provides a conservative token estimate, not an exact tokenizer.
Actual input/output usage anchors subsequent estimates, including durable
continuations. The UI continues to report measured usage rather than estimates.

Completed turns persist the canonical tool conversation and native items.
Followups reuse that checkpoint only for the same owner, session, model, and
connection revision. Model/connection changes use portable visible history, not
another provider's encrypted state. Project knowledge remains in instructions,
outside the history being compacted.

## Verification boundary

On October 4, 2026, a live Codex subscription test through `runModelAgent` forced
compaction of synthetic history, JSON-roundtripped the encrypted checkpoint, and
correctly recalled the verification word in the next inference. It emitted
compaction status and two usage events without leaking opaque state to chat.
No task VM or paid API fallback was used.

Adapter and loop regressions cover native replay, capability discovery, measured
and estimated triggers, summary fallback, and deadline checks. Direct OpenAI and
Anthropic native compaction have fixture coverage, not live-provider verification.
This establishes the mechanism, not a benchmark of long-session recall quality.

Fallback regression coverage also checks intact recent reasoning/tool sequences,
archive failure without history replacement, and owner/chat-scoped retrieval.
A synthetic original context round-tripped through live encrypted storage, and
scoped archive cleanup was verified against that storage. Test archives were
removed. This is storage verification, not a live non-native
model compaction test.

October 4 provider-specific update: a synthetic evidence record was uploaded,
found through live archive search, retrieved unchanged, and blocked from another
chat scope. Only the new proof object was removed. No provider inference or VM
was started for that proof. Real SDK wire-format fixtures cover OpenRouter
encrypted-only replay, DeepSeek historical reasoning, and xAI/OpenAI compact
output conversion. This does not establish live compaction across all providers.

The earlier compaction regression run passed 234 test files: 1,126 tests passed and 3 were
skipped. Typecheck, lint, production build, and the Cloudflare bundle dry run
passed. The existing development Node worker was redeployed and its process
startup verified. The unused, unconfigured edge test deployment was removed;
this change does not cut execution over to Cloudflare or change database schemas.

The provider-specific update passed 238 test files: 1,145 tests passed and 3 were
skipped. Lint, application and workflow typechecks, production build, and the
Cloudflare bundle dry run passed. This update has not been deployed: the final
read-only development fleet check found no existing `ytimesy-job-worker` and no
active API turns. No replacement persistent VM was provisioned.

Ranked retrieval follow-up: 238 test files passed (1,149 tests passed, 3 skipped).
Live encrypted storage verification also found evidence via an alternative query,
returned its preceding message, recovered the canonical original, and rejected
cross-chat access. The synthetic proof archive was removed. This establishes
retrieval mechanics, not measured recall improvements or live model tool selection.
The remote deployment boundary above remains unchanged.

## Future exploration: dynamic context discovery

Deferred by user decision on October 4, 2026; this is not implementation work
authorized by the note. Inspired by a competitor's
[dynamic context discovery article]([link removed]
keep original information accessible and retrieve only what the current task needs,
instead of putting everything into the model window upfront.

Before extending the harness, audit existing implementations to avoid duplication:

- Preserve long tool outputs as recoverable artifacts rather than only truncating
  them. Return bounded previews and references for later search/read.
- Make terminal history searchable, with bounded retrieval of relevant output.
- Discover and load relevant skill instructions on demand.
- Discover MCP tool definitions on demand instead of supplying the full catalog
  on every request.
- Evaluate semantic history retrieval alongside ranked lexical search only if it
  improves recovery on representative paraphrased questions.

Searchable encrypted pre-compaction history and original-message retrieval already
exist; the items above are exploration targets, not claims that other capabilities
are absent or that competitor parity is established. Any future implementation should
preserve owner/chat isolation, retention and deletion rules, and secret filtering.
Measure retrieval accuracy, context tokens, latency, and cost against the current
harness before adopting additional infrastructure.

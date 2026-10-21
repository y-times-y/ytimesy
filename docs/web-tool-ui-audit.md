# Web chat timeline: tool and item audit

Audit of how the chat timeline (`src/features/sessions/session-timeline.tsx`) renders everything the current harness writes into a transcript. It was taken against `launch` at c32cba0 and covers the default variant (lean surface) plus the opt-in variants: code mode, subagents, lead fusion, review, attempts and rigor.

The inventory comes from the code that builds tool sets and writes items. That code is:

- `LEAN_SHAPE_TOOLS` and `BUILDER_SHELL_TOOLS`.
- `turnTools` in `api-turn.ts`.
- `subagent-tools.ts` and `code-mode-tool.ts`.
- `api-progress.ts`, `review-loop.ts` and `attempt-loop.ts`.
- `turn-commit.ts` and `failoverNotice`.
- The retired names in `harness-performance.ts`.

How rendering works today:

- Every tool call is a `dynamicToolCall` item. Its card comes from `toolActivity` (label) and `activityGlyphForToolName` (icon, plus grouping under "Explored").
- An unknown tool falls back to its name in words and a wrench icon.
- Inputs and results print as raw JSON.

**Gaps found: 33 of 45 rows** (23 tools, 10 items). Each one is changed in the UI except one: sidekick classifier notices, which never reach the transcript and need server work.

## Tools

| Tool (shape / where offered) | Today: icon · label · summary · detail | Problem | Change |
|---|---|---|---|
| `bash` `read` `write` `edit` (core lean, default) | terminal/file/pen · "Ran `cmd`", "Read a.ts", "Wrote", "Edited +n −m" · input JSON | Input detail is a raw JSON blob | Input as labelled fields |
| `exec_command` (codex lean) | terminal · "Ran `cmd`" | none | none |
| `write_stdin` (codex lean) | hourglass · "Waited for command output" / "Stopped command" | Fallback icon heuristic reads "write" as an edit | Explicit icon table entry (wait) |
| `apply_patch` (codex lean, shell surface) | pen · "Edited/Created/Deleted file +n −m" | none | none |
| `view_image` (codex lean, shell surface) | image · "Viewed shot.png" | none | none |
| `Bash` `Read` `Write` `Edit` (claude lean) | as core | Input JSON | Input fields |
| `Glob` `Grep` (claude lean) | search · "Found files `pattern`" / "Searched" | `Glob` is not grouped under "Explored" (its heuristic icon is the wrench) | Explicit icon table: search, so it groups |
| `run_shell_command` `read_file` `write_file` (gemini/qwen lean) | as core | none | none |
| `replace` (gemini lean edit) | **wrench** · "Edited notes.md" | Generic wrench icon for an edit | Pen icon |
| `glob` `grep_search` (gemini/qwen lean) | search · "Found files" / "Searched" | `glob` is not grouped under "Explored" | Grouped |
| `execute_command` `continue_command` `stop_command` (shell surface) | terminal/hourglass/stop · "Ran", "Waited", "Stopped command" | none | none |
| `read_environment_report` | book · "Read environment report" | none | none |
| `check_deliverable` | **wrench** · "Check deliverable" (fallback) | Generic label and icon, command not shown | flask · "Checked deliverable `./run.sh …`" |
| `read_context_archive` `search_context_history` | file/search · "Read context archive" / "Search context history" (fallback) | Counted as an explored file or search; fallback label | history icon · "Read earlier context" / "Searched earlier context `query`" |
| `browser_open` `browser_screenshot` `browser_inspect` `browser_execute` | **wrench** · "Browser open" … (fallback), no target | Generic, URL and script hidden | browser icon · "Opened localhost:3000/settings", "Took a browser screenshot", "Inspected url · 1 check", "Ran browser script `code`" |
| `report_task_blocked` (subagents) | **wrench** · "Report task blocked" | Fallback wording from the old task design | message icon · "Asked for a decision `question`" |
| `web_search` `google_search` (hosted search) | search · "Searched the web `query`" | Result is a JSON blob | Result as fields |
| `read_plugin_skill` | book · "Read skill" | Target missing: the label reads `name`, but the tool takes `skill` | Reads `skill` |
| `mcp__<server>__<tool>` | heuristic icon · "server · tool" | `search_issues`/`read_*` MCP tools get the code-search or file icon and are folded into "Explored" | Always the plug icon, never grouped |
| `search_mcp_tools` `call_mcp_tool` (large MCP setups, run_code) | search/wrench · fallback label | Fallback labels; `search_mcp_tools` counted as a code search | plug · "Searched MCP tools `query`", "server · tool" |
| `enter_plan_mode` | **wrench** · "Enter plan mode" | Fallback, reason hidden | plan icon · "Entered plan mode" plus the reason |
| `propose_plan` (failed call only) | **wrench** · "Propose plan" | Fallback | plan icon · "Proposed a plan" (success stays the plan card) |
| `request_project_secret` (refused call only) | warning · "Request project secret" | Fallback, name hidden | key icon · "Asked for secret `NAME`" (accepted stays the secret card) |
| `agent` (subagents: writer/researcher/reviewer/checker; fusion sidekick, `explore`) | **wrench** · "Agent `title`" · input and output JSON | No role, model or status. Brief and report are JSON, report header shown raw. Sidekick and explore rounds look the same as anything else | bot icon · "Reviewer `title` `model`" with status (Finished/Failed). Sidekick and explore rounds are named. Opens to the brief (markdown), the report (markdown, with header facts as a meta line) and the budget. The subagent card below the call opens its transcript |
| `agent_send` | **wrench** · "Agent send", no target · JSON | Says nothing about what was sent | bot · "Messaged agent `1`" / "Explore round for agent `1`" / "Stopped agent `2`" with the status ("Round 2/6 started"). Opens to the message |
| `run_code` (code mode) | **wrench** · "Ran code `read ×2 · mcp__linear__get_issue`". Program shown open; inner calls as cards with raw JSON input; refused calls labelled Failed | Raw tool names in the summary; program noise; JSON inputs | code icon · "Ran code Read ×2 · Edited · Ran · linear · 5 calls, 1 not completed". Program collapsed ("Program · 3 lines"), "N tool calls" each as a one-line card that opens to labelled fields |
| `review_check` (review loop, synthetic) | **wrench** · "Review check" · input "independent review 1 of up to 2" · result text | Verdict, findings and fix answers sit in a monospace blob | Verdict card: shield in verdict colour · "Review 1 of 2 · Fail · 2 findings · 4 tests, 1 failed · fixed 1, rejected 1". Opens to the round history, findings, failing tests with commands, and spend. The server now adds "Checker tests: N run, M failed." |
| `attempt_check` (attempt loop, synthetic) | **wrench** · "Attempt check" · text | Same as above | Same card: "Attempt 2 of 3 · Pass · kept attempt 2", with the selection reason and spend |
| Retired tools in older chats (17 lead/child task tools, `read_files`, `run_checks`, `inspect_code`, `browser_click` …, from `harnessToolName`) | mostly **wrench** · name in words | Generic | Each has an icon. The task tools read "Coordinated subagents" with the old name as a note. The rest get short verbs ("Ran checks", "Inspected code", "Clicked") |
| Any tool not listed | wrench · name in words | Expected fallback | Kept. A test now fails when the harness lists a tool without a mapping |

## Items

| Item | Today | Problem | Change |
|---|---|---|---|
| `userMessage` (and hidden child-event wake-ups) | bubble; internal child-event text hidden | none | none |
| `agentMessage` with rigor `<requirements>` block | Tags stripped by markdown; the items run together into one paragraph | Unreadable; looks like prose | Collapsed "Requirements 4" list (numbered). A block still streaming shows the lines so far |
| `reasoning`, `plan` (todos), `planProposal`, `secretRequest`, `memorySave` | existing cards | none | none |
| `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `unknown` | existing rows | Not written by the current server (Codex app-server legacy); fine | none |
| `error` (e.g. Codex HTTP 403) | red row, **one line with ellipsis** | The remedy ("…choose another model. No fallback was used.") is cut off | Wraps |
| `modelSwitch` switched (failover) | switch icon, same weight as a tool row, one line with ellipsis | Long notice cut off; as loud as a tool row | Quiet system notice: smaller, muted, wraps, full text on hover |
| `modelSwitch` `sidekick-escalation` (switch at compaction) | as above | as above | as above, tagged `data-reason` |
| `modelSwitch` awaitingApproval | Continue/Wait card | none | none |
| `notice` (commit/push publication notes) | **book (guide) icon**, one line with ellipsis | Wrong icon; cut off | Info icon, quiet system notice that wraps |
| Compaction | No transcript item: the composer's context ring animates; the timeline says "Thinking" | Timeline gives no sign the turn is compacting | Working line reads "Compacting context" while the latest request's usage says so |
| Sidekick classifier notices (`hand_back`, `switch_model`) | Model-facing only (in the lead's report message); `switch_model` surfaces later as `modelSwitch` | Never in the transcript, so there is nothing to render | None in the UI. Showing `hand_back` needs the server to write a `notice` item (left as follow-up) |
| Review-loop findings notice (runtime notice to the builder) | Model-facing only | Covered by the `review_check` card | none |
| Subagent report (header, Patch, "Left out" scratch summary, large-patch warning) | Model-facing. Visible only in a waited reader's `agent` result (raw `[agent 2 reviewer finished · …]` header in JSON) and in the subagent card's own transcript | Raw header and JSON | Header parsed into the report's meta line; report as markdown. Patch/"Left out"/warning lines read as plain text in the subagent's transcript |
| Subagent card (`AgentTaskActivity`) | "Fix picker · Task 1 · model"; "Task instructions"; "Waiting for child agents" | Lead/child wording from the removed design; no role | "Reviewer 2 · model", "Brief", "Waiting for subagents" |
| Tool input/result detail, all tools | Raw JSON text | Hard to read | JSON objects render as labelled fields; text stays text |

## Verification

- `src/features/sessions/tool-mapping.test.ts` builds the tool list from the harness's own lists and factories:
  - `leanToolNames()`, `BUILDER_SHELL_TOOLS` and `nativeWebSearchTools(provider)`
  - `pluginSkillTools`, `planTools` and `secretRequestTools`
  - the MCP, deferred, image, agent, code-mode and loop constants
  - the `harnessToolName` enum

  It fails when any of these has no explicit icon or falls back to the generic label. It also renders the verdict, agent, run_code, requirements, notice and compaction views.
- Screenshots of a sample transcript holding every item above, before (c32cba0) and after, are local only under `.ytimesy/ui-audit/{before,after}/`.

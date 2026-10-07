# Claude-inspired harness behaviors

Implemented on `codex/claude-harness-gaps`, based on the committed Cursor worktree
at `d7b8095`. The sibling Oh My Pi checkout was left untouched. No permission
rules, new database schema, deployed services, or paid inference were introduced.
These changes serve ytimesy's custom Codex-subscription and API model loops.
The native Claude Code adapter retains its own runtime behavior.

## Repository context

The runtime loads root AGENTS.md/CLAUDE.md automatically and loads ancestor
instructions when repository tools first access a nested scope. An edit that
discovers new instructions is deferred until the model receives those instructions;
the model must reconsider and retry. Root instructions are reloaded after both
foreground and background compaction, with a hard context-budget check.

Stable SHA-256 evidence from file reads survives durable steps and compaction.
Before model steps, the runtime checks the latest 32 read paths and reports changed
or unavailable contents once until the file is reread. Changed instruction files
are reloaded. A hash establishes byte freshness, never correctness. Existing
repository path, symlink and private-file boundaries still apply. This does not
implement Claude's full `.claude/rules` frontmatter or external memory system.

## Lifecycle workflows

Track `.ytimesy/hooks.json` in the repository's baseline commit. This project's
`.ytimesy/` directory is ignored, so intentionally tracking just this configuration
requires `git add -f .ytimesy/hooks.json`. The runtime reads the configuration from
the server-owned verification baseline, rather than agent-edited working files.

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "Stop",
      "command": "npm test >/tmp/ytimesy-test.log 2>&1 || printf '{\"continue\":true,\"message\":\"Tests failed; inspect /tmp/ytimesy-test.log and repair them.\"}'",
      "timeoutSeconds": 15
    }
  ]
}
```

Supported events: PostToolUse, PostToolUseFailure, PostCompact, Stop. An optional
`tool` filters by exact tool name. Commands receive JSON in `YTIMESY_HOOK_INPUT`;
oversized input becomes a marked, bounded preview. Stdout must be empty or one JSON
object with optional `message` and boolean `continue`. Nonzero exits, stopped
commands, malformed verdicts and truncated verdicts are failures. Post-tool failures
produce feedback while preserving the original tool result; a failing Stop hook
prevents completion. Stop continuation is capped at three and counted from the
durable command journal, including across compaction/restarts. PostCompact feedback
is delivered before the next model request.

Hooks use the existing fenced command executor and idempotency journal. An uncertain
command is not automatically replayed. Hooks run only in writable task workspaces;
read-only leadership does not provision a VM to run hooks. Limits are 16 hooks,
4,000 command characters and 55 seconds per hook. Hooks add workflow feedback,
not an action-permission policy.

## Conversation and code recovery

Eligible user messages offer Recover from here: restore conversation, fork it, or
restore code/both where a code point exists. Conversation recovery keeps actual
provider history as well as public timeline items, restores before the selected
prompt, and puts that prompt back in the composer. It does not reuse opaque history
for a different model/connection revision. A fork gets independent task ancestry
and a new lazy workspace; it forks conversation, not the original working files.

Code points are captured before the first workspace access of each admitted writer
turn. Code recovery requires an existing isolated writable child workspace. Git
snapshots preserve binary data, file modes, staged/unstaged contents and nonignored
untracked files. A pre-restore snapshot is retained under private
`refs/ytimesy/recovery/*`; metadata lives in the existing command journal.
The existing disaster-recovery Git bundle includes these refs. Branch/HEAD history,
ignored dependencies/credentials, and external actions are outside code rewind.
Backups are retained for operator recovery; an automatic undo button is not included.

Recovery locks the session and descendants, rejects active turns/children, captures
a backup, then checks checkout/index/HEAD drift before replacement under the existing
edit lock. External terminal writers do not participate in that lock; avoid editing
the checkout during recovery. Error handling preserves backup refs and never blindly
overwrites concurrent edits. Restored task review is marked pending. Original API
turns and prior conversation records remain retained. No database migration is needed.

## Verification and continuous regression

`pnpm harness:regression` runs local behavioral checks for instruction refresh,
deferred edits, stale reads, hook pinning/replay/failure/continuation, real Git
recovery, owner scoping/forks/active turns, compaction wiring, and existing evaluation
grading/regression rules. It writes `.ytimesy/harness-regression.xml`. The PR/main
workflow runs this command and uploads its result. It performs no paid inference.

Local evidence includes real Git repositories, real shell hooks/artifact capture,
PGlite database queries, mock model streams, TypeScript/build checks, and an
agent-browser fixture exercising the actual recovery component. On macOS the hook
test substitutes only the Linux process fence; production fence behavior has its
own existing tests. Browser fixture checks are not authenticated cloud/VM proofs.
Competitive quality/speed and representative model compliance still require the
existing paired evaluation machinery with identical task/model/environment budgets.

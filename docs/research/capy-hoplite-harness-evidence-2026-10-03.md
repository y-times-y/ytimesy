# Capy and Hoplite harness evidence — 2026-10-03

Public first-party sites, docs, API reference and changelogs inspected with `agent-browser`, isolated session `capy-hoplite-research`. No accounts, inference runs, private repositories or logged-in interfaces were used. This establishes published behavior, not independently tested production behavior. Competitor descriptions stand independently of this repository's architecture.

## Architecture claims and proof boundaries

| Product/path | What the source establishes | What it does not establish |
| --- | --- | --- |
| Capy cloud | [Machines](https://docs.capy.ai/machines) explicitly says: “The agent loop runs on Capy's servers; the machine is where execution happens.” Threads and agents retain durable identity while VM backings change. | Whether a connected Codex subscription uses an unmodified native Codex runtime, a fork, an API transport or another internal adapter. Device authorization and subscription coverage do not answer that. |
| Capy desktop/local | [Changelog](https://capy.ai/changelog), Sept 10, says threads run in local folders with local git credentials and terminal tabs; Oct 1 documents moving cloud work back to a Mac. | The inspected sources do not name local Codex app-server or Claude Code Agent SDK execution. Importing their histories does not prove native execution. |
| Hoplite cloud | [Docs](https://hoplite.sh/docs) calls this managed execution; [Tools](https://hoplite.sh/docs/agent/tools) exposes its own shell, patch, workspace, delegation, credentials and plan interfaces; [Context](https://hoplite.sh/docs/agent) describes context Hoplite assembles before model calls. | The underlying loop implementation or whether GPT cloud turns execute native Codex binaries. Calling them Codex agents in a changelog and accepting ChatGPT authentication are insufficient proof. |
| Hoplite desktop/local | [Desktop](https://hoplite.sh/docs/desktop) explicitly names Codex `app-server` and Claude Code through Anthropic's Agent SDK against the installed `claude` executable. Existing login/configuration are used locally. | Local evidence cannot be generalized to cloud execution. |

## Capy current behavior

### Leaders, children and peer work

[Subagents](https://docs.capy.ai/subagents) describes full child agents with their own conversations and tools, capable of opening PRs and recursively delegating to three levels. The agent drafts each child's title and prompt, then explicitly starts it. A draft does no work.

The context boundary is explicit: “A subagent starts from its prompt alone.” Children do not see the parent's history, prior corrections or previously explored files. The parent receives final summaries automatically; it reads interim progress only on request. Blocked questions notify the parent; ordinary progress does not wake it.

Placement must be explicit: shared machines expose the parent's uncommitted tree and suit read-only exploration; fresh machines boot a clean upstream checkout for writers. Parallel writers should touch disjoint files and produce separate PRs; overlapping/dependent work is stacked sequentially from the previous PR branch. The parent inspects the child's diff and can patch, publish or request revisions. Models are independently selectable, inheriting the parent by default. Sibling root threads have independent workspaces and can be created/messaged by another agent, but their state must be read explicitly. [Subagents](https://docs.capy.ai/subagents).

Captain is a separate long-running coordination layer, not synonymous with every parent agent. Sept 24 introduced Captain and Memory under Experiments; a Captain directs other root threads as crew. Oct 1 fixed crew replies reaching the Captain and Captain Drive arriving during a running crew turn. Current API documents [Captain creation](https://docs.capy.ai/api-reference/captains/create-captain), [crew listing](https://docs.capy.ai/api-reference/captains/list-captain-crew), and a [digest](https://docs.capy.ai/api-reference/captains/get-captain-digest) read from `DIGEST.md`, then `ONGOING.md`, then `NOTES.md`. These prove current existence; they do not disclose a full Captain scheduling algorithm. [Changelog](https://capy.ai/changelog).

### Context and durable memory

[Instructions](https://docs.capy.ai/instructions) loads root `AGENTS.md` (or `CLAUDE.md` fallback) at start; nested tracked `AGENTS.md` and glob rules load on first matching file-tool contact, once per thread. Shell commands do not trigger nested injection. Instructions and skill descriptions share a bounded context budget with visible shortening markers. Deprecated `.capy/BUILD.md`, `.capy/CAPTAIN.md` and `.capy/REVIEW.md` are no longer read.

[Skills](https://docs.capy.ai/skills) advertises name/description/path, then reads instructions on demand. Repository skills override Drive, which overrides built-ins; Drive scope orders project-personal, personal, project, organization. Built-ins include environment setup, computer use and stacked PR workflows.

[Drive](https://docs.capy.ai/drive) stores instructions, skills and files outside git across organization, personal, project, project-personal and automation scopes. Automation Drive holds run state rather than instructions/skills. Saved changes persist automatically; scratch/checkout files are excluded. File history records versions and originating threads, with restoration creating another version. Current docs state 24-hour version history.

[Models](https://docs.capy.ai/models-and-pricing#connections) exposes a per-model compact threshold in organization settings. The homepage demonstration says automatic compaction at 80%, but this is a marketing UI sample, not proof that every configuration has that threshold. Sept 24 Memory remains an experimental feature in the changelog; its deeper retrieval/write policy is unspecified by the inspected docs.

### Execution and recovery

[Machines](https://docs.capy.ai/machines) separates durable machine identity from replaceable backing. Ubuntu 24.04 VMs have passwordless sudo, Node/Python/Docker/build tools and Chrome. Idle machines sleep about two minutes after active work stops. Tracked background operations keep them awake; detached servers do not. Sleep preserves disk but loses processes/memory/connections; startup runs on wake. Cold storage begins after two sleeping days; deletion after 30. Replacement can lose unpushed checkout edits, installed packages and scratch state; pushed work and Drive survive. Different machines exchange files via `transfer_files`.

[Environment](https://docs.capy.ai/environment) uses initialize, refresh-on-checkout-change, ordered startup entries with readiness ports, and named commands. Setup may live in `.capy/setup.json` or app configuration; file-owned setup changes require PR workflow. Failed setup degrades the workspace and warns the agent rather than preventing all work. Snapshots cache prepared setup, restore in claimed 1–2 seconds, rebuild on changed inputs in hourly checks and fall back to full setup when unavailable. Reviews boot fresh machines pinned to PR head, with read-only credentials and pushes disabled.

[Troubleshooting](https://docs.capy.ai/troubleshooting) says lost edits may be reconstructed from conversation history. A balance stop is durable and needs a human message or retry after funding; no automatic balance polling resumes it. This is conversation-based recovery, not a guarantee of exact filesystem reconstruction.

### Validation, wakeups and controls

[Pull requests](https://docs.capy.ai/pull-requests) couples commit/push/PR creation to event subscription. Failed checks wake a repair pass; all passing checks consolidate into a result; review/human comments and merge events wake the owner. Bot comments default to ignored with allowlisting available. Ownership follows the latest thread to push the branch. Manually opening a PR with `gh pr create` does not register those wakeups, per [Troubleshooting](https://docs.capy.ai/troubleshooting).

[Security](https://docs.capy.ai/admin/security) says merges and auto-merge require a specific explicit request in the current conversation. No-merge-without-request, no exposing/committing secrets, and no fabricated results are non-overridable. GitHub credentials stay in Capy's proxy; VMs receive only short-lived proxy grants. Configured secret values may still be printed by agent commands, so secrecy in management APIs does not mean commands cannot access them.

[Threads](https://docs.capy.ai/threads) documents interrupt, queue and steer; default Enter interrupts, Cmd/Ctrl+Enter queues, Alt/Option+Enter steers. Status buckets derive from the agent/subagent tree. Archive suppresses automatic wakeups while retaining arriving context; a human message revives it. Todo plans are visible. Full-text command search, configurable shortcuts and folders aid many-thread supervision. [Machines](https://docs.capy.ai/machines) supplies terminal, diff, files and live desktop views; exposed apps require an awake machine.

### Historical reconciliation

The [Oct 3 changelog](https://capy.ai/changelog) explicitly renamed tasks to subagents across app, CLI, Slack and docs; API remains `tasks`. Codex subscription GPT-6 context changed from 400K to 1.05M, while fast stays 272K. Sept 30 unified model connections and introduced explicit routing order/fallback behavior. Therefore older provider-prefixed models and Captain/Build instruction files should not be presented as current defaults. Homepage pricing still advertises Captain/Build/Review agents, while current instructions explicitly deprecate those per-agent files: role marketing survives, but the current operational docs describe generic root agents plus subagents and experimental Captains.

## Hoplite current behavior

### Coordination and context

[Tools](https://hoplite.sh/docs/agent/tools) exposes `subagent_control`, shared/fresh workspace role distinctions and scoped cross-thread access. Repository agents can search same-project history including others' threads; continuing another thread is restricted to the same project and invoking user's own target, excluding self-messaging and recursive bounces. The inspected documentation does not specify child prompt-only versus forked history, delegation depth, or full peer messaging semantics.

[Review UI](https://hoplite.sh/docs/threads/review) has durable child panels with activity, approval and completion/error states. The child prompt is hidden in that page's description; the Oct 2 [changelog](https://hoplite.sh/changelog) subsequently adds child task/model details and steering/queueing. Aug 17 described independent writing child workspaces as a limited organization rollout; this is not proof every account now receives it.

[Context](https://hoplite.sh/docs/agent) combines repository, project, thread and initiating-user context. Durable personal memories are inspectable/editable/deletable and restricted to stable explicit preferences, excluding project facts, commands, temporary task state, raw transcripts and secrets. Agents may write them without per-write approval; later runs see updates, current runs keep immutable snapshots. Unattended automations do not inherit private memory. [Skills](https://hoplite.sh/docs/agent/skills) uses repo and hosted personal bundles, with repo precedence; personal imports copy root instructions only and exclude automations.

[Run](https://hoplite.sh/docs/threads/run) exposes a context gauge and manual `/compact`; oversized model/preflight context automatically compacts once and retries. Oct 2 [changelog](https://hoplite.sh/changelog) describes prepared-project-context reuse across steps, parallel checking of background instruction changes with output held until validation, and less setup work after helper/preview operations. These document latency optimizations, not their undisclosed internal implementation.

### Persistence and environment

[Workspace lifecycle](https://hoplite.sh/docs/sandboxes) gives each thread a persistent workspace identity across follow-ups. New default workspaces use Modal snapshot-replace persistence; native suspension remains an alternative and Daytona compatibility still exists. Active Modal work refreshes baseline recovery snapshots. Confirmed runtime/worktree failure restores the latest snapshot; newer unpushed work can be lost. Archive/restore differs from thread archive, and restarted processes need relaunch.

The same page documents Docker Compose runtime selection from explicit project choice or bounded repo inspection (Compose, Supabase, Testcontainers and related evidence). A later discovered requirement can replace runtime while preserving uncommitted and ignored worktree files; machine-global state/processes do not carry. Docker runs as an unprivileged user through restrictive proxy policy. [Previews](https://hoplite.sh/docs/sandboxes/previews) offers managed servers, port discovery, authenticated durable app URLs and Terminal; internal browser/terminal URLs expire across sandbox generations.

### Validation and continuation

[PRs](https://hoplite.sh/docs/github) tracks linked checks and review feedback. Opt-in autofix wakes repair runs, queues feedback behind current ownership, and supports specified reviewer-bot identities. It pauses on repeated same-state runs or 12 runs/hour; after ten runs without human input it disables until explicitly re-enabled. Auto-merge is separate. CLI-created PRs must be linked. Rebase publication uses an exact remote-head lease.

[Goals](https://hoplite.sh/docs/agent/slash-commands) continuously resumes unfinished cloud work through ordinary permission/billing boundaries. Claude/most models use a separate tool-free completion evaluator and stop-hook feedback; GPT gets `get_goal`/`update_goal` and Codex-style continuation instructions. That describes emulated/vendor-aligned goal behavior, not proof of native cloud harness execution. Goals stop for completion/blockage, errors/cancellation, limits or repeated tool-free runs (three GPT, eight others).

[Run controls](https://hoplite.sh/docs/threads/run) queue Enter and steer Cmd/Ctrl+Enter; `/stop` is durable cancellation with Stopping until terminalization, unavailable during setup. `/retry` resumes workspace state without rollback. Explicit [checkpoint listing](https://hoplite.sh/docs/api/listThreadCheckpoints) and [restore](https://hoplite.sh/docs/api/restoreCheckpoint) are separate. After credit exhaustion, a UI can commit/push surviving edits without inference. [Approvals](https://hoplite.sh/docs/threads/review) persist structured answers and expire unanswered approvals after 72 hours, releasing holds.

### UX, controls and native local boundary

[Tools](https://hoplite.sh/docs/agent/tools) protects secrets/env/CI/infra/outside-repo writes, policy-gated shell, restarts/downsizes and user preview checklists. Ordinary repository edits/read/browser/status work proceeds. Private scoped GitHub App credentials can exist in the sandbox's CLI configuration—different from Capy's proxy-only design.

[Desktop](https://hoplite.sh/docs/desktop) stores local native-provider threads/runs/approvals in SQLite under `~/.hoplite`, syncs after reconnect and publishes local threads to the organization by default. The desktop host owns execution while teammates may message/approve/stop. Local Codex retains its configured approval policy; Claude uses SDK auto permission mode with explicit asks preserved. Local Diff exists, managed cloud Preview/Terminal does not.

[CLI](https://hoplite.sh/docs/cli) 3.x is a remote cloud-thread terminal client, not merely a history importer: streams tools/approvals, supports ACP, remote command/shell and uncommitted-change push. 2.x import/handoff remains. It acknowledges its interactive client is modified from Vercel `fx`. [Manage](https://hoplite.sh/docs/threads/manage) provides state groups, PR-aware attention, durable notes and redacted transcript export including nested child traces and compaction summaries.

## Remaining unknowns

Neither public doc set establishes private cloud source code, exact provider transport, internal scheduler guarantees, all retry/idempotency semantics, child conflict-resolution reliability, or independently measured acceptance rates. Capy does explicitly publish server loop location; Hoplite explicitly publishes native local adapters. The evidence should not be stretched beyond those boundaries.

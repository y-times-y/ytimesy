# Coding-agent harnesses: what would it take to be the clear winner?

Research snapshot: **2026-10-03**. Coverage: Codex, Claude Code, Cursor, Capy, Hoplite, Vorflux, and Devin. This is a competitor-first investigation, deliberately independent of ytimesy's existing architecture.

## Executive conclusion

**A competent harness is necessary, but a feature-complete harness is not sufficient to lead this market.** Parallel agents, persistent memory, browser testing, review agents, cloud environments, and event-driven continuation already appear across these products. Their execution details differ substantially; checking the same boxes does not make them equally effective.

The competitive target should be: **more accepted, correct work with less human supervision, at an acceptable total cost and elapsed time**. “Accepted” must mean the requested behavior works and the change remains useful—not that an agent generated a confident summary or opened a PR.

The strongest lessons from this research are:

1. **The model and harness are a coupled system.** Cursor documents model-specific tools and prompts, and Composer training in the deployed harness. A universal wrapper is not automatically as effective as a tuned integration. [Harness tuning](https://cursor.com/blog/continually-improving-agent-harness), [Composer training](https://cursor.com/blog/composer-2-technical-report).
2. **More orchestration is not automatically better.** Anthropic's experiments changed the amount of scaffolding as models improved; Cursor removed strong exploration-delegation instructions. Coordination must earn its cost. [Anthropic experiments](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Cursor efficiency](https://cursor.com/blog/improved-token-efficiency).
3. **Durable orchestration and preserved execution state are different.** Capy's thread can survive a replacement VM while unpushed files do not. Devin separately documents recorded workflow replay. Reliability requires knowing exactly which state survives. [Capy machines](https://docs.capy.ai/machines), [Devin workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows).
4. **Verification is itself an engineering problem.** An additional model can approve the same mistake. Browser evidence can cover only a narrow flow. The acceptance standard and evaluator need independent validation. [Anthropic evaluator calibration](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Devin testing scope](https://docs.devin.ai/work-with-devin/testing-and-recordings).
5. **There is no defensible overall winner from these documents alone.** This report establishes mechanisms and published limits, not a controlled quality ranking. A clear-winner claim needs comparative product runs and retained-use evidence.

## 1. Definitions and evidence boundaries

A **model** predicts useful outputs. A **harness** assembles its context, exposes tools, executes actions, manages feedback and continuation, and applies operational controls. The **environment** supplies files, programs, services, browsers, and compute. The **product** adds collaboration, inspection, billing, integrations, and workflow UX. These layers interact, but should not be conflated. OpenAI explicitly separates its hosted harness, execution environment, and application server. [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture).

This report uses three evidence levels:

- **Documented:** an official source describes a mechanism or limitation. This establishes the vendor's public specification, not independently verified reliability.
- **Vendor result/claim:** a first-party experiment, benchmark, speed, quality, or cost assertion. Its scope matters; it is not a head-to-head product trial.
- **Analysis/proposal:** our interpretation or a hypothesis to test. Unknown means undisclosed or unverified, **not absent**.

Official documentation, engineering posts, changelogs, and benchmark-owner sources were read. Public pages were also inspected using isolated `agent-browser` sessions. **No authenticated competitor task, paid inference, benchmark trial, private backend inspection, or source-code implementation audit ran for this report.** Public-page inspection is not hands-on verification of the logged-in products. Living docs are an access-date snapshot; release and plan gates must be pinned before testing.

This covers all seven named/reference products, not every coding-agent project in existence. Local CLI, cloud product, SDK, and research prototypes are identified separately below.

## 2. Comparative map

This table summarizes the detailed sourced sections; it is not a scorecard.

| Product | Distinctive documented mechanism | Context and coordination | Verification/recovery boundary |
| --- | --- | --- | --- |
| Codex | Reusable native harness and lifecycle protocol; separate OpenAI-managed Agents API | Inspectable subagent threads; skills; local memories; compaction events | Sandbox/approvals and turn controls; native integration is not equivalent to calling its model |
| Claude Code | Adaptive tool loop plus lifecycle hooks | Fresh/forked subagents, peer messages, experimental teams, local memory | Hooks can enforce checks; checkpointing excludes important shell/child mutations |
| Cursor | Provider/model-specific harness tuning and production feedback | Dynamic context, selective delegation, cloud child VMs; Composer trained with compaction | Tool-error instrumentation, event-driven PR continuation; research swarm is not the product specification |
| Capy | Server-side loop separated from execution machines | Prompt-only children, sibling-thread communication, scoped Drive, experimental Captain | PR-event wakeups; thread durability does not preserve every disposable VM file |
| Hoplite | Project/thread/user context plus bounded goal and PR continuation | Scoped delegation, personal memory, context reuse | Persistent workspace snapshots with possible loss since last snapshot; cloud/native-local distinction |
| Vorflux | User-configurable role models/instructions and reviewed dependency plans | Role subagents; visible shared file memory and reconciliation | Separate browser-testing task and evidence; subagent isolation and rollback details remain unclear |
| Devin | Managed child sessions and recorded Python Dynamic Workflows | Indexed repo understanding, skills, structured orchestration | Recorded-result replay; focused browser QA; cloud and CLI capabilities differ |

## 3. Codex: a reusable execution system, not just a coding model

### What is established

OpenAI describes the same open harness powering its app, CLI, and IDE extension. It owns context, tool interaction, streamed activity, sandbox/approval behavior, and continuation. Integrators can reuse that system rather than recreate it. This does **not** make a direct call to an OpenAI coding model a native Codex run. [Codex as a platform, Aug 19, 2026](https://developers.openai.com/blog/codex-as-a-platform).

Its app-server protocol exposes threads, turns, execution items, approvals, resume, interruption, steering, and explicit compaction progress. `turn/steer` targets an active turn using its expected ID; it is not a new independent turn. The documentation warns that WebSocket transport is experimental and unsupported, including remote-listener authentication hazards. Protocol availability is not a production deployment guarantee. [App-server](https://learn.chatgpt.com/docs/app-server).

Current local releases support delegation when the user or applicable instructions request it. Subagents isolate noisy work and return summaries; their activity is inspectable. OpenAI warns that each child consumes additional tokens and parallel writes can create conflicts. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Skills initially expose metadata and load instructions when relevant. Local memories are a separate optional mechanism generated from eligible past chats, with controls for reading and contributing; they are not a transcript backup or model-weight update. [Skills](https://learn.chatgpt.com/docs/build-skills), [Memories](https://learn.chatgpt.com/docs/customization/memories).

Sandbox policy and approval policy are distinct controls. OS execution restrictions provide a boundary beyond a prompt telling the model to behave; container configuration can affect whether the native sandbox works. [Approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

### Native Codex versus managed Agents API

These are different integration surfaces. The Agents API runs an OpenAI-hosted Codex loop, maintains sessions, and connects to optional hosted or self-hosted execution environments. Its overview specifies API-rate model billing; do not assume subscription billing from the Codex name. [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture), [Overview and billing](https://developers.openai.com/api/docs/guides/agents-api/overview).

The official Codex SDK instead controls local Codex threads; the Python SDK controls local app-server and includes a pinned CLI dependency. An SDK is therefore not necessarily a remotely hosted inference service. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

Managed recovery docs explicitly require checking saved state and completed side effects before retrying. A disconnected stream does not prove the turn failed. Even a completed turn requires inspecting tool results. [Agents API recovery](https://developers.openai.com/api/docs/guides/agents-api/errors).

### Quality mechanism and limits

OpenAI's long-horizon example emphasizes iterative edits, tests, observations, repairs, and externalized state—not one enormous prompt. Its 25-hour demonstration is a vendor experiment, not a reliability guarantee for arbitrary user projects. [Long-horizon experiment, Feb 23, 2026](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex).

**Analysis:** the reusable advantage is continuity plus trustworthy execution feedback. Unknown here: controlled lift from each harness component, current native/cloud behavior under identical budgets, and how much of a rival's “Codex” integration reuses this native system.

## 4. Claude Code: adaptive context, feedback hooks, and several distinct collaboration modes

### Context and the tool loop

Claude Code describes gathering context, acting, and verifying repeatedly. It exposes file/search/shell/web tools, clears older tool results, compacts history, and discovers skill/MCP content on demand. This enables verification; it does not establish an unconditional test gate on every request. [How it works](https://code.claude.com/docs/en/how-claude-code-works).

Instructions, session history, and auto memory serve different purposes. Auto memory is local project-scoped Markdown; only a bounded index loads initially. Root instructions are restored after compaction, with nested rules loaded when relevant. The docs explicitly distinguish instructions from enforced lifecycle requirements. [Memory](https://code.claude.com/docs/en/memory).

### Collaboration: do not use outdated assumptions

Current named subagents can message peers and nest, with a documented default depth of three and configurable concurrency. Fresh children receive a task prompt; forks inherit context. Tool/model/permission/memory scopes can differ. Older blanket statements that Claude children cannot delegate or communicate are stale. [Subagents](https://code.claude.com/docs/en/sub-agents).

Agent teams are separate full sessions with lead/teammate messaging and shared task coordination when Task tools are available; availability is model-dependent. They remain experimental and interactive-only: headless/SDK sessions cannot spawn teammates, and resume does not restore in-process teammates. The docs identify premature lead completion and lagging task status among operational limits. [Teams](https://code.claude.com/docs/en/agent-teams), [Task-tool availability](https://code.claude.com/docs/en/tools-reference#task-tool-availability).

Cross-session messaging is another surface, with local or cloud routing and inbound controls. A peer message does not create user authorization or override permissions. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

### Enforcement, recovery, and concrete quality evidence

Hooks can deny tools or require more work before stopping, but continuation is bounded. Sandbox execution restrictions are distinct from permission classification. Checkpoints do not cover Bash mutations or most subagent edits; “rewind” must not be presented as a complete workspace rollback. [Hooks](https://code.claude.com/docs/en/hooks), [Sandboxing](https://code.claude.com/docs/en/sandboxing), [Checkpoint limits](https://code.claude.com/docs/en/checkpointing).

Anthropic's April 23, 2026 postmortem attributes Claude Code regressions to effort defaults, a thinking-retention bug, and a brevity instruction while the API layer was unaffected. This is direct first-party evidence that harness choices change the user's experience, although not a published randomized ablation. [Postmortem](https://www.anthropic.com/engineering/april-23-postmortem).

Anthropic's long-running experiments used incremental feature lists, progress files, Git, and real browser verification. Later experiments calibrated evaluators and reduced scaffolding for a stronger model. These are experimental SDK workflows, not universal stock defaults; the richer pipeline also used much more time and money. [Initial experiment](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Follow-up](https://www.anthropic.com/engineering/harness-design-long-running-apps).

**Analysis:** Claude's strongest documented combination is context management plus extensible feedback/enforcement. Inspected sources do not establish or quantify joint optimization of today's peer-message/team protocols with current model training; shared vendor ownership alone cannot establish that moat.

## 5. Cursor: tailored harnesses and a measured improvement process

### Mechanisms that go beyond a generic wrapper

Cursor's April 30 engineering post describes provider/model-specific prompts and edit tools, dynamic context, and special transition instructions when changing models mid-chat. Its evaluation loop includes offline tests, online experiments, code retention, user-response interpretation, and per-tool/per-model error monitoring. It treats unexpected tool errors as harness bugs. **Analysis:** this is a repeatable improvement process, not merely an orchestration diagram. [Harness engineering](https://cursor.com/blog/continually-improving-agent-harness).

Its September 23 efficiency post describes smaller prompts, demand-loaded tool schemas, cache reuse, compact file observations, and selective subagent use. It reports a 7% token-cost reduction without quality loss—a vendor result, not replicated here. In particular, it removed strong instructions to delegate exploration and constrained model selection for children. [Token efficiency](https://cursor.com/blog/improved-token-efficiency).

### Native model alignment and cloud execution

Composer 2's report documents RL in realistic sessions using the deployed tools/harness. Self-summarization is trained with compaction in the loop, rewarding summaries as part of successful trajectories. That is materially different from adding a summarization prompt to an unrelated model. Results remain Cursor's own evaluations. [Training report](https://cursor.com/blog/composer-2-technical-report), [Compaction training](https://cursor.com/blog/self-summarization).

Subagents start with clean context supplied by the parent, can run foreground/background, and use worktrees or cloud environments. Cloud children use team-configured MCP rather than the local session's servers. The cloud product documents event subscriptions, mid-turn steering, and PR-check/comment repair. [Subagents](https://cursor.com/docs/subagents), [Aug 19 release](https://cursor.com/changelog/08-19-26).

Cloud security docs specify dedicated per-agent Firecracker VM boundaries and a separate execution AWS account. The product exposes desktop takeover and environment/setup diagnostics. These controls do not by themselves measure output correctness. [Security](https://cursor.com/docs/cloud-agent/security), [Capabilities](https://cursor.com/docs/cloud-agent/capabilities).

### Research is not the shipped-product specification

Cursor's February swarm research reports failures from unstructured shared coordination and an overloaded executor. Its later design used recursive non-coding planners, independent workers, and upward handoffs—not peer worker conversations. It deliberately tolerated intermediate errors to improve throughput. **Do not generalize this research design or tolerance to every customer Cloud Agent.** [Self-driving codebases research](https://cursor.com/blog/self-driving-codebases).

**Analysis:** Cursor supplies unusually explicit evidence of harness tuning and measurement. Its disclosed internal metrics are useful research directions, not proof that retaining code equals correct code or that its product wins every task.

## 6. Capy: server-owned continuity, explicit placement, and event-driven work

### Current architecture—not inferred from authentication

Capy's machine docs explicitly place the agent loop on Capy's servers and execution in isolated VMs. Thread/machine identity can survive replacement while unpushed edits, packages, scratch files, and processes are disposable. Snapshot boot overlaps the first model turn; sleep preserves disk but loses processes. **This establishes loop location, not whether its private subscription adapter runs native Codex.** [Machines](https://docs.capy.ai/machines).

### Parent, subagent, peer, and Captain are different concepts

Children begin from their prompt alone, not parent conversation history. They have independent conversations, recursively delegate, and return final summaries. Shared placement suits read-only inspection of the parent's work; fresh placement supports independent writers; dependent changes can stack. Interim progress must be read explicitly, while blocked questions notify the parent. Sibling root threads can be messaged. These context boundaries determine whether corrections reach the worker. [Subagents](https://docs.capy.ai/subagents).

Current Captain is an experimental long-running crew coordinator, not a synonym for every parent agent. The Oct 3 changelog renames tasks to subagents; old role-specific instruction files are deprecated. February Captain/Build descriptions must therefore not be copied as timeless architecture. [Changelog](https://capy.ai/changelog), [Current instructions](https://docs.capy.ai/instructions).

### Context, validation, and human controls

Drive supplies scoped persistent files/instructions/skills with versions outside Git; skills load on demand. This is an external context surface, not evidence of an undisclosed retrieval algorithm or learned model weights. [Drive](https://docs.capy.ai/drive), [Skills](https://docs.capy.ai/skills).

Environment configuration separates initialization, checkout refresh, and startup/readiness. Failed setup can yield a degraded workspace warning for repair; fresh PR review machines are pinned to the review head with read-only credentials. [Environment](https://docs.capy.ai/environment).

PR publication registers check/review/merge wakeups. A manually created unregistered PR may not get that continuation. Merge authority requires an explicit request; GitHub credentials stay in a proxy rather than the VM. Users can interrupt, queue, or steer. [PR lifecycle](https://docs.capy.ai/pull-requests), [Troubleshooting](https://docs.capy.ai/troubleshooting), [Security](https://docs.capy.ai/admin/security), [Threads](https://docs.capy.ai/threads).

**Analysis:** the benefit is ongoing work ownership across events, with explicit context and execution boundaries. Public evidence does not establish the private scheduler, native subscription runtime, or comparative coordination success rate. “Agents can message” is not “they will avoid every conflict.”

## 7. Hoplite: context-aware continuation and inspectable execution

### Cloud versus native local execution

Hoplite's **desktop** docs explicitly identify local Codex app-server and Claude Agent SDK execution. Its cloud docs expose Hoplite-managed tools/context but do not name the equivalent underlying native runtime. Device-code authentication does not bridge that evidence gap. [Desktop](https://hoplite.sh/docs/desktop), [Cloud tool surface](https://hoplite.sh/docs/agent/tools).

### Context and coordination

Hoplite combines repository/project/thread/user context. Personal memory records stable preferences, excludes secrets/raw transcripts/temporary task state, and does not enter unattended automations. Active runs retain their original memory snapshot. [Context and memory](https://hoplite.sh/docs/agent).

Delegation distinguishes shared/fresh workspaces and scopes cross-thread access. Current child UI documents activity and approvals; Oct 2 adds task/model details and steering, alongside prepared-context reuse and background instruction validation. The docs do not fully specify child history inheritance or peer-delivery semantics. [Tools](https://hoplite.sh/docs/agent/tools), [Review UI](https://hoplite.sh/docs/threads/review), [Changelog](https://hoplite.sh/changelog).

### Recovery and closed-loop work

New default Modal workspaces use snapshot-replace persistence with a stable thread workspace identity. Recovery can lose unpushed work newer than the latest snapshot; processes need restarting. Detected project requirements can change runtime while transferring worktree files. [Workspace lifecycle](https://hoplite.sh/docs/sandboxes).

Goal continuation differs by model family: GPT gets goal tools; Claude and most other models use a separate completion evaluator and stop-hook feedback. Repeated tool-free runs and errors/limits stop continuation. PR autofix is opt-in, bounds repeated cycles, and keeps auto-merge separate. [Goals](https://hoplite.sh/docs/agent/slash-commands), [PR continuation](https://hoplite.sh/docs/github).

Run controls distinguish queue, steer, durable stop, retry without rollback, and checkpoints. Preview URLs survive workspace identity while internal connection URLs can expire. [Run controls](https://hoplite.sh/docs/threads/run), [Previews](https://hoplite.sh/docs/sandboxes/previews).

**Analysis:** bounded continuation and honest recovery semantics are important strengths. Unknown here: exact cloud loop implementation, comparable outcome rates, and reliability of concurrent writer integration.

## 8. Vorflux: explicit roles, reviewed plans, and separately steerable QA

### The harness is exposed as configuration

Harness Builder maps models/instructions to main, explore, plan, build, debug, review, simplify, and testing roles. Team/personal/session settings and phase toggles are explicit; custom instructions cannot override safety/permission constraints. This is a workflow configuration surface, not proof that its default role graph is optimal. [Harness Builder](https://vorflux.ai/docs/harness-configurator).

Plan mode gathers context, produces dependency-bearing tasks, incorporates internal review, and lets the user approve an exact plan version. Independent builders run concurrently; dependent work runs sequentially. Child transcripts/artifacts/failure states are exposed. The subagent page does not establish an independent VM for every child role. [Plans](https://vorflux.ai/docs/plan-mode), [Subagents](https://vorflux.ai/docs/subagents).

### Visible memory and observable verification

An account-shared `/memory/` volume stores categorized knowledge, testing procedures, preferences, and other state. Used excerpts are visible and correctable. A daily reconciler merges overlap, resolves contradictions, and retires stale records; agents are instructed to verify memory against source. Retrieval/write-concurrency quality is not disclosed. [Memory](https://vorflux.ai/docs/memory).

Testing agents drive a real browser and return evidence-linked reports. Blocked testing questions route to that testing task without pausing the main session. This is useful for long tests that need access or setup help. External PR reviews have configurable scope, limits, and optional testing/risk assessment. [Testing](https://vorflux.ai/docs/testing), [PR review](https://vorflux.ai/docs/pr-reviews).

Workspace UI exposes compaction events, tools, plans, diffs, desktop, and artifacts. Archive retains conversation/artifacts but releases the machine; exact uncommitted-file recovery is not established. Autopilot can approve plans and choose suggested answers, so its speed must be evaluated alongside consent and error risk. [Workspace](https://vorflux.ai/docs/session-workspace), [Lifecycle](https://vorflux.ai/docs/session-lifecycle), [First-session controls](https://vorflux.ai/docs/first-session).

**Analysis:** Vorflux makes intermediate decisions and memory unusually explicit in its documentation. Homepage claims about cross-lab review and production-ready delivery remain unverified here; they do not establish comparative superiority. Unknowns include child filesystem isolation, compaction loss, full cancellation semantics, and acceptance rates. [Homepage claims](https://vorflux.ai/).

## 9. Devin: managed workers and programmable durable workflows

### Repository understanding and execution are separate

Devin offers indexed repository investigation and executable Agent sessions with shell, IDE, browser, and human takeover. Indexing is separate from provisioning an environment. Its docs do not publish every cloud prompt, routing policy, or stopping rule. [Introduction](https://docs.devin.ai/get-started/devin-intro), [Indexing](https://docs.devin.ai/onboard-devin/index-repo).

Skills use deferred instruction loading and branch-local overrides; the current Knowledge guide describes migration toward managed-plugin Skills. Do not treat old Knowledge-note descriptions as the entire current memory design. [Skills](https://docs.devin.ai/product-guides/skills), [Knowledge migration](https://docs.devin.ai/product-guides/knowledge).

### Coordination with a concrete replay mechanism

Managed Devins are coordinator-owned child sessions, normally on separate VMs. The coordinator scopes, monitors, messages, resolves conflicts, and aggregates. Launch approval and organizational permissions can constrain delegation. [Managed sessions](https://docs.devin.ai/work-with-devin/advanced-capabilities).

Dynamic Workflows put orchestration into Python using agents, pipelines, parallel calls, and structured outputs. Completed call results are recorded and replayed on resume, while unfinished work gets new sessions. Prompt/schema/settings changes invalidate matching cached work. Determinism requires external observations inside recorded calls. Separate VMs use Git handoffs; shared-VM writers need disjoint work. This is workflow replay—not replaying arbitrary model reasoning deterministically. [Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows).

### Verification, permissions, and surface differences

Cloud testing records focused real-app sanity flows, can need help for access, and does not replace exhaustive CI. Devin Review can route findings back for autofix, with rollout/support qualifications. [Testing](https://docs.devin.ai/work-with-devin/testing-and-recordings), [Review autofix](https://docs.devin.ai/work-with-devin/devin-review#auto-fix).

Mandatory Security Profiles intersect restrictions across scopes, including children; recommended defaults can be overridden. Policies resolve at boot/wake rather than instantly rewriting an active session. Outpost operators must enforce their own network rules. Sessions have a documented 30-day continuation limit. [Profiles](https://docs.devin.ai/product-guides/security-profiles), [Common issues](https://docs.devin.ai/admin/common-issues).

CLI Adaptive routing, Fusion lead/sidekick pairing, and CLI subagent policies are documented separately; they must not be silently attributed to every cloud run. CLI children have fresh contexts; background approvals and nesting are constrained. [Adaptive](https://docs.devin.ai/cli/adaptive), [Fusion](https://docs.devin.ai/cli/fusion), [CLI children](https://docs.devin.ai/cli/subagents).

**Analysis:** recorded orchestration is a particularly concrete reliability mechanism. It does not prove the agent made the right decisions or that resumed side effects are safe without inspecting handoffs and state.

## 10. What is already claimed—and therefore not a unique advantage

The intersections below are occupied by inspected competitors. This is not an exhaustive novelty search or a statement that all implementations work equally well.

| Proposed differentiator | Existing evidence above | Competitive implication |
| --- | --- | --- |
| Leader/coordinator plus builders | Capy Captain/crew; Cursor research planners; Devin coordinators | An organization chart is not a moat |
| Peer messaging | Current Claude subagents/teams; Capy sibling threads | Delivery capability alone does not prove self-coordination quality |
| Independent review or judge | Vorflux roles; Anthropic experiments; Devin Review | Must measure error detection and false positives |
| Persistent repo/user memory | Codex, Claude, Capy Drive, Hoplite, Vorflux, Devin skills | Accuracy, scope, correction, and freshness matter more than existence |
| Real browser evidence | Cursor, Vorflux, Devin; Capy desktop/tools | Evidence must cover acceptance, not just a happy-path video |
| Always-on PR repair | Capy, Hoplite, Cursor | Safe ownership, bounded retries, and final verification are the differentiators |
| Per-model tuning and cheaper specialists | Cursor tuning; Devin Fusion; Vorflux role mapping | Generic multi-model support is already available |
| Durable resumable workflows | Devin recorded workflows; hosted Agents API; cloud workspace persistence | Measure actual recovery, including partial external effects |

Search-based exploration and backtracking are also not a new category: SWE-Search studies multi-agent MCTS and iterative feedback on repository tasks. Its research results are not a guarantee for arbitrary production apps. [SWE-Search, revised Apr 2, 2025](https://arxiv.org/abs/2410.20285).

**Conclusion:** none of these individual ingredients supports a “nobody else does this” narrative. A new entrant must outperform the implementation quality, combine them more effectively, or serve a workflow where the existing products still demonstrably fail.

## 11. What a genuinely superior harness would have to do

The following are **independent product requirements and research hypotheses**, not claims of novelty, implementation status, or a commitment to the current architecture.

### A. Turn intent into a testable contract

Infer likely acceptance conditions, inspect the real application, and ask only the questions that change the result. Preserve scope, forbidden actions, expected behavior, and completion evidence across agents and compaction.

**User-visible difference:** fewer “it works” responses followed by discovering the requested behavior was never tested.

**Test:** deliberately ambiguous requirements; verify that clarification or inspection prevents materially wrong work without producing a permission-question loop.

### B. Allocate effort to uncertainty, not fixed roles

Use a single execution path for easy tasks; investigate, parallelize, challenge, or backtrack when uncertainty warrants it. Distinguish independent hypotheses from dependent edits. A fresh agent needs the critical decisions and negative findings, not just the task title.

**User-visible difference:** small tasks stay fast, hard tasks get deeper investigation, and repeated agents do not repeat the same unsuccessful approach.

**Test:** ablate single agent, fixed team, and adaptive coordination under the same total budget. Include integration time, reviewer cost, and unsuccessful branches.

### C. Maintain evidence-grounded task state

Track which claim is supported by which command, revision, browser flow, or artifact. A test passing on a child's old branch must not count as proof for the merged final tree. Keep unresolved assumptions and failed attempts available without flooding context.

**User-visible difference:** inspectable proof attached to the actual delivered change, with honest unknowns.

**Test:** stale evidence, changed branches, fabricated summaries, incomplete tests, and new integration failures must prevent unsupported completion claims.

### D. Close the feedback loop without supervising every step

Observe workers, failures, CI, and access blockers; revise the plan when necessary. Peer messages should reduce duplicate work without becoming conflicting authority or endless discussion. Preserve explicit action ownership.

**User-visible difference:** the user does not become the scheduler, conflict resolver, or person repeatedly reminding an idle leader to check children.

**Test:** children finishing early, failing, asking questions, editing overlapping files, or finding contradictory facts. Measure duplicate work and unattended recovery, not message volume.

### E. Make continuity correct, not merely convenient

Recover conversation, files, processes, browser state, and external actions according to explicit guarantees. Stop should stop owned work. Retry must check what already happened before repeating actions. Validate memory against the current project.

**User-visible difference:** reconnecting or resuming does not lose edits, silently rerun publication, or resurrect canceled work.

**Test:** kill the stream, worker, and execution environment independently; revoke credentials; change branch; restart mid-tool; inject a stale memory. Check effects independently.

### F. Be responsive and honest at the interface

Acknowledge submission immediately and show genuine setup/model/tool states. Expose understandable tool inputs/results and child activity without overwhelming the chat. Permit steering. Do not fabricate thinking traces or promise a model's reasoning before the provider emits supported output.

**User-visible difference:** the user understands what is happening, can intervene, and sees results without decoding infrastructure logs.

**Test:** time to acknowledgement, first real progress, time to actionable failure, reconnect fidelity, scroll/expand behavior, and keyboard/mobile inspection.

### G. Improve from outcomes—with authorization

Use consented, scoped feedback to learn which contexts, tool shapes, handoffs, and checks predict accepted work. Evaluate changes before rollout and preserve a rollback path. Training rights, product analytics, operational storage, and private customer code are separate decisions.

**User-visible difference:** recurring mistakes actually become less frequent, rather than more transcripts merely accumulating.

**Test:** held-out tasks and users after a harness change; require quality gains without unacceptable latency, cost, privacy, or safety regressions. This improvement loop is not unique—Cursor already documents one.

## 12. How to prove superiority rather than declare it

### Two comparisons, not one

1. **Harness-isolation track:** same model/version, reasoning settings, environment resources, tools available, credentials, and total budget. Compare orchestration/context/verification changes. Where a closed product cannot expose equivalent controls, mark that comparison unavailable rather than pretending it is controlled.
2. **Best-product track:** each product's recommended configuration, including native models and workflow advantages. Compare the experience the customer can actually buy. Report model and harness effects together; this answers product value, not isolated harness causality.

### Task mix

Use repository bug fixes, cross-layer features, authenticated UI flows, unfamiliar-code refactors, environment/CI repairs, and long-running changes requiring resume and correction. Include tasks where collaboration should help and tasks where it should not. Include private fresh tasks so benchmark familiarity cannot explain every gain.

SWE-bench supplies repository-issue evaluation; its current default Verified view standardizes models in mini-SWE-agent, so that view alone is not a comparison of all commercial harnesses. Terminal-Bench evaluates agent/model pairs on executable tasks; pin the exact release and resource policy rather than mix leaderboard generations. [SWE-bench](https://www.swebench.com/), [Terminal-Bench](https://www.tbench.ai/), [Release history](https://www.tbench.ai/news).

### Primary and guardrail outcomes

- **Primary:** independently accepted tasks per fixed budget; human intervention minutes per accepted task.
- **Quality:** hidden behavioral checks, regressions, maintainability, security, and code retained after later use.
- **Time:** end-to-end p50/p95, including setup, questions, retries, merge/integration, and verification.
- **Cost:** all root/child/judge inference, failed candidates, compute, and verification—not only the winning answer.
- **Reliability:** partial-action recovery, cancellation, lost-work rate, unauthorized actions, and truthful completion.
- **Experience:** inspection effort, correction success, and willingness to keep using the product.

Pre-register the sample, settings, budgets, acceptance rules, and analysis. Counterbalance task order; run repeated trials; blind human review; count setup failures and failed attempts in the denominator. Use paired uncertainty estimates and determine sample size from a pilot, not one successful demo. Protected evaluators must not be available to agents or enter training data. Terminal-Bench's integrity policy explicitly addresses solution access and benchmark alteration. [Integrity policy](https://www.tbench.ai/news/leaderboard-integrity-update).

### A proposed decision standard

Before implementation, choose a meaningful improvement target with actual users. For example: a materially higher independently accepted-task rate **and** lower supervision, at a bounded total cost, with no safety regression. The target and sample size are not established by this report.

A “clear winner” requires that advantage to persist across representative workflows and repeated use against the strongest available alternatives. A benchmark point, prettier tool cards, more agents, or a larger tool catalog cannot establish that alone.

## 13. Recommendation and next decision

**Do not start by copying all seven systems into one pipeline.** That would collect their coordination costs as well as their strengths. Start with the user outcome, identify a recurring measurable failure, then test the smallest harness intervention that repairs it better than the strongest relevant baseline.

The highest-value investigation suggested by this landscape is **evidence-directed completion with adaptive effort**: can a system spend its next action on the most consequential uncertainty, preserve what was learned, and stop only with revision-correct acceptance evidence—while asking the human less often?

This is an ambitious research direction, **not an unclaimed invention**. Planning, evaluation, memory, and adaptive delegation already exist. The potential advantage would be a demonstrably better decision policy and execution quality, supported by a repeatable measurement/improvement process. It must be earned in experiments.

Before selecting an architecture, run authorized comparative product trials to answer the remaining questions: actual child coordination, context loss after compaction, tool reliability, authenticated app verification, recovery, and cost per accepted task. Public documents reveal what to test; they cannot replace those tests.

## Supporting research and refresh rules

Detailed primary-source notes accompany this comparison:

- [Claude Code evidence](claude-harness-evidence-2026-10-03.md).
- [Capy and Hoplite evidence](capy-hoplite-harness-evidence-2026-10-03.md).
- [Devin and Vorflux evidence](devin-vorflux-harness-evidence-2026-10-03.md).

All linked sources were accessed during this research snapshot. Publication dates are named where relevant; undated docs are current-access snapshots, not release promises. Recheck feature flags, versions, account access, billing, and deployment constraints before testing or implementing. Unknown private internals must remain unknown unless primary evidence or an authorized reproducible observation establishes them.

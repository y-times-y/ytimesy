# Claude Code harness: sourced evidence

Accessed 2026-10-03. Public primary Anthropic documentation and engineering/research posts only. Read using the isolated `agent-browser --session claude-harness-research read` workflow; public web search helped discover sources. No account login, inference call, benchmark execution, or product implementation was performed. This describes documented behavior, not independently measured reliability. Living documentation includes release-specific changes; pin the installed CLI version before treating any feature as available.

## What the harness contributes

Claude Code documents an adaptive loop of gathering context, taking action, and verifying results. The model chooses actions; the surrounding program exposes tools, manages context, and supplies reminders. File access, search, shell execution, web access, and optional code-intelligence plugins turn a text model into an agent. Verification is an activity the model performs through tools; this documentation does not establish an unconditional test gate for every task.

Context includes messages, file contents, tool results, instruction files, skills, and system instructions. The harness clears older tool outputs before summarizing conversation history. `/compact` can focus preservation; automatic compaction eventually stops rather than repeatedly thrashing when a huge output immediately refills context. Skills load their bodies on demand, and MCP tools are discovered on demand. These are context-selection mechanisms, not model-weight memory. [Official architecture documentation](https://code.claude.com/docs/en/how-claude-code-works).

## Memory and continuity

Session persistence and cross-session memory are distinct. Conversations are recorded in local JSONL and can be resumed or forked. [Session documentation](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions).

Auto memory is local Markdown under a project memory directory shared by a repository's worktrees. The startup budget for its `MEMORY.md` index is the first 200 lines or 25 KB, whichever is reached first; topic files load through ordinary file reads when needed. Memory records user preferences, feedback, ongoing project decisions, and external references, rather than everything derivable from source. It is not automatically synchronized across machines or cloud environments. Main-session auto memory does not load into a fresh subagent; a fork inherits conversation context, and custom subagents can have their own memory scope.

Instruction files are another mechanism. Project-root `CLAUDE.md` is reread after compaction; nested instructions and path-scoped rules reload when relevant files are read. The documentation explicitly says instruction text is not guaranteed strict compliance and recommends hooks for requirements that must run at a lifecycle point. [Official memory documentation](https://code.claude.com/docs/en/memory).

## Delegation: current behavior differs from older descriptions

Subagents have their own context, prompt, tool list, model, and permission configuration. Fresh subagents receive a delegation message rather than full main-session history; forked subagents inherit history. Explore and Plan skip ordinary instruction files and git-status context; this matters when a delegated investigator must obey project-specific constraints.

Named subagents can use `SendMessage`, including peer messages. Their startup sibling roster is a snapshot and requires the documented version/tool conditions. The current default allows nested delegation to three layers below the main conversation; the depth is configurable. The documented concurrency default is 20 active subagents, separately configurable. These defaults changed across releases. It is therefore stale to say Claude subagents categorically cannot message peers or spawn children.

Definitions can preload skills, scope memory, limit turns, and isolate work in worktrees. Ordinary isolated delegation is useful when only a concise result needs to enter the caller's context. [Official subagent documentation](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup), [nesting](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents), [concurrency](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).

Agent teams are separate full sessions managed by a lead. They exchange messages directly; tasks support dependencies and file-locked claiming when Task tools are present. JSON mailbox files implement team delivery, and malformed entries are removed while valid messages continue. Teammates start with project context and a spawn prompt, without the lead's conversation history. Quality gates can reject task completion or teammate idleness.

Teams remain experimental and disabled by default. They require interactive sessions: `-p` and Agent SDK sessions do not spawn teammates. Named delegation may become a teammate when teams are enabled. Current limits include no restoration of in-process teammates on resume/rewind, lagging task status, no nested teams, a fixed lead, and delayed shutdown. Teammates can stop on errors; the lead can conclude before all work finishes. The docs recommend monitoring and steering. This is a real coordination feature, not evidence of guaranteed autonomous completion. [Official agent-team documentation](https://code.claude.com/docs/en/agent-teams).

Since v2.1.268, Task tools are not exposed by default on every model. Newer models can track work without those tools; explicit opt-in restores them. Background/cloud sessions have different defaults. A subagent and in-process teammate follow the parent session's Task-tool availability. Teams without them coordinate through messages. [Official tool-availability documentation](https://code.claude.com/docs/en/tools-reference#task-tool-availability).

## Peer sessions outside a team

Cross-session messaging is a third channel: `ListAgents` discovers sessions, and `SendMessage` passes text. Local delivery uses per-session sockets on macOS/Linux or named pipes on Windows; other-machine and cloud delivery uses Anthropic infrastructure and the documented Remote Control/account requirements. Messaging can wake an idle recipient or arrive between tool calls during a turn.

An incoming peer message cannot supply user consent, change permission configuration, or execute a slash command just by including its text. Receiving-session permissions still apply. Inbound `accept`, `hold`, and `refuse` controls, cross-machine approval settings, size/burst caps, repeat suppression, and bounded queues constrain the channel. Same-machine availability begins at v2.1.224 on macOS/Linux and v2.1.234 on native Windows, with further provider/version qualifications. [Official cross-session messaging documentation](https://code.claude.com/docs/en/cross-session-messaging).

## Enforcement, feedback, and recovery

Hooks run at defined lifecycle events. `PreToolUse` can deny an action before it executes; post-tool hooks can attach feedback; Stop/SubagentStop hooks can require continuation. A Stop hook may return `decision: block` and a reason. Continuation is bounded, including an eight-consecutive-continuation cap, so a hook is not an infinite completion guarantee. Experimental agent hooks can inspect files through a subagent and return a structured decision after up to 50 turns; the docs recommend command hooks for production workflows. [Official hooks reference](https://code.claude.com/docs/en/hooks#stop-decision-control), [agent hooks](https://code.claude.com/docs/en/hooks#agent-based-hooks).

Auto mode is a separate approval classifier, rather than the task model simply deciding its own authority. Explicit permission rules resolve first with documented exceptions; permitted reads and working-directory edits generally bypass classifier calls; other actions go to classifier review. Subagent tasks are checked at spawn, actions while running, and final work/report review. The latter can attach a warning rather than suppressing the report. Classifier requests strip ordinary tool results; separate server-side scanning examines incoming results. This separation is a documented design, not proof that injection is solved. [Official permission-mode mechanics](https://code.claude.com/docs/en/permission-modes#how-auto-mode-evaluates-actions).

Sandboxing supplies an independent execution boundary. Default sandbox filesystem behavior allows writes in the working directories and temp directory, while reads are broader except denied directories; credentials require explicit protection. Network isolation is separate. [Official sandbox documentation](https://code.claude.com/docs/en/sandboxing#filesystem-isolation).

Checkpointing covers direct file-tool edits, with significant limits: Bash mutations are not tracked; most subagent edits are not restored; external changes and symlinked/hard-linked paths are excluded. A foreground forked skill is a documented subagent exception. Git remains the durable recovery mechanism. [Official checkpoint limits](https://code.claude.com/docs/en/checkpointing#limitations).

## Evidence that harness choices affect quality

Anthropic's April 23, 2026 postmortem reports three product regressions with the API/inference layer unaffected: changing default effort from high to medium, repeatedly clearing older thinking because of a bug, and adding a verbosity-reduction instruction. They were reverted/fixed by April 20, v2.1.116. This is unusually direct first-party causal evidence that compute settings, context retention, and system prompts affect coding behavior. It is retrospective internal diagnosis, not a published randomized ablation. [Engineering postmortem](https://www.anthropic.com/engineering/april-23-postmortem).

The November 26, 2025 long-running-agent experiment found compaction alone insufficient for a high-level app-building task. An initializer created a feature list, startup script, progress log, and git history; subsequent sessions made incremental progress and verified the running app. Browser testing exposed problems missed by unit tests or HTTP checks. These are task-specific Agent SDK scaffolding experiments, not automatically enforced stock Claude Code defaults. [Long-running harness experiment](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

The March 24, 2026 follow-up used planner/generator/evaluator roles with browser-driven QA and negotiated criteria. The evaluator needed skeptical prompting and calibration because naive graders were lenient and superficial. One illustrated Opus 4.5 comparison cost $9/20 minutes solo versus $200/6 hours with the harness, with richer functional output. That comparison changes time, cost, scope, and orchestration simultaneously and cannot isolate multi-agent superiority. With Opus 4.6, the author removed sprint scaffolding and moved evaluation to the end; the useful amount of scaffolding depends on the model and task. [Application-development harness experiment](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Model–harness training: supported and unknown

Anthropic's November 21, 2025 research says it ran reinforcement learning on real programming tasks from actual Claude training runs. Its research model was later evaluated through standard Claude Code. This establishes relevant coding-RL environments and deployment-scaffold evaluation, not that the currently deployed Claude model was optimized end-to-end for every present Claude Code feature. [Reward-hacking research](https://www.anthropic.com/research/emergent-misalignment-reward-hacking).

The January 9, 2026 evals article describes Claude Code's improvement through internal/user feedback, narrow and more complex evals, production monitoring, A/B tests, and research/product collaboration. It explicitly treats an evaluated agent as model plus harness. [Agent evals article](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

The September 29, 2025 Agent SDK article presents the same core infrastructure as reusable beyond coding and describes context gathering, execution, and feedback mechanisms. It recommends concrete verification rules, visual feedback, and selective judges. This is first-party engineering guidance and product positioning, not a disclosure of the model's training recipe. [Agent SDK engineering article](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk).

Unresolved from inspected primary sources: whether specific current tool schemas, compaction summaries, peer-message protocols, or team orchestration traces participate in joint post-training; how much benchmark lift comes from that alignment; proprietary prompts/algorithms behind automatic decisions; and comparative quality/cost against a custom harness under controlled budgets. Do not convert shared vendor ownership or relevant coding-RL training into a quantified co-training moat.

## Comparative conclusion

Claude Code's documented advantage is a mature bundle: adaptive tools, context selection, persistent instructions/memory, isolated/forked delegation, peer communication, enforcement hooks, execution boundaries, and recovery surfaces. These mechanisms address identifiable failure modes. The strongest evidence argues for reproducing feedback and continuity properties in a comparator and measuring the whole agent; it does not establish that maximizing agent count or permanently adding more scaffolding improves results.

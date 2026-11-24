# Thread-to-thread communication and a shared project drive: Capy vs ytimesy

Research and design, 2026-11-24. No production code changed.

## 1. Capy (sources: docs.capy.ai, fetched 2026-11-24)

**Thread to thread** ([Projects](https://docs.capy.ai/projects), [Background work](https://docs.capy.ai/async-work), [FAQ](https://docs.capy.ai/faq))
- Type `@` and pick a thread, or paste its code (`WEB-1234`). The agent can read its owner, status, pull requests, subagents and full history, and search its messages. Reading never wakes the other thread.
- The agent messages another thread only when asked. It arrives there as a steer; the reply wakes the asking thread.
- A thread stays in its project and cannot be moved.

**Captains** ([Captains](https://docs.capy.ai/captains), [feature page](https://capy.ai/features/captains))
- A Captain runs a crew of threads in its own project; it hears from a crew thread each time it finishes a turn or needs something. Captains can read and message each other. `CREW.md` holds rules every crew thread reads each turn; crew leave `reports/`, `renders/`, `handoffs/` in the Captain's Drive.
- A Captain acts as its owner, with the owner's GitHub access and keys; crew share that access.
- Not stated in the docs: rate limits, message caps, automatic loop protection, the Captain-to-Captain mechanism. The only brakes are user-written rules.

**Drive** ([Drive](https://docs.capy.ai/drive); formerly "Volumes")
- Files, `AGENTS.md` instructions and `skills/<name>/SKILL.md` kept outside git, shared by scope: Organization, Personal, Project, Project + personal, Automation; each Captain has its own.
- Org and Project drives are visible to org members; Personal ones are not browsable by others. All scopes stay inside one organization.
- Changes save automatically as work completes; no commit. Checkout and scratch files are excluded. Desktop threads get a copy in `~/.capy/drive/`.
- Versions: History lists them with the threads that made them; Restore creates a new version; versions are kept 24 hours.
- Limits: 1 / 10 / 25 / 50 GB per org (Free / Lite / Pro / Max), 100 MiB per file, 32 MB per browser upload. When full, saves fail with a "Drive is full" card.
- Per [FAQ](https://docs.capy.ai/faq) as summarised by search: each cloud thread boots its own machine, so threads never share a disk; Drive is the shared place for files.

**Could not verify:** how a cloud thread reads Drive (mount path, sync timing), concurrent-write conflict handling, Captain loop limits, whether "steer" has a rate limit. The FAQ sentence on separate machines came from a search summary; I did not open the FAQ page itself.

## 2. ytimesy today (code-backed)

**(a) @-mentioning a thread.** `src/server/services/agent-mentions.ts`. `@ytimesy-12` is matched only when the project part is this project's; a root thread of the same user and project is looked up by `thread_number` (`threadByNumber`, metadata row, no transcript). The agent receives one extra user note: `thread "<title>" (id …, working|idle|archived)`. It gets no content, and a mention grants no new tool: the note says "what the thread tools take", but those tools exist only for Y² (`docs/y.md`). An ordinary Y/worker thread can therefore see that a thread exists, nothing more.

**(b) Tools.**
- Y² (`src/server/services/y-squared-tools.ts`, `docs/y.md`): `threads` (one DO list request), `thread` (status, last request, PR, full final reply, questions, plan, canvases via `deps.outcome`), `read_canvas`, `show_canvas`, `view_image`, `start_thread`, `message_thread` (`queue` default, `steer`, `interrupt`), `stop_thread`, `schedule`. Scope: same user, same project, root threads only, not Y² itself. Bounds: 8 starts per Y² turn, 50 queued messages per chat, idempotency key per turn+content hash, normal admission (32 concurrent turns per user, usage windows, Freestyle and Cloudflare budgets). Y² never reads transcripts and has no VM.
- `agent_send` (`src/server/services/agent-peer-messaging.ts`): `steerableChild` allows only a started direct child of the sender (same owner and project, not a draft), 1–8,000 chars. So it works within one chat's helper tree and **cannot reach another chat**. Workers cannot message sibling threads or Y².
- Y² is woken by `YSquaredCrew` DO per project (`src/server/edge/y-squared-crew.ts`); about 50 DO requests/hour for a busy hour, ceiling about 80 (`docs/y.md`).

**(c) Project-level shared state.**
- Project memory (`docs/project-knowledge.md`): Markdown in Postgres `project_briefing.text`, revisions in `project_memory_revision`, 120,000 characters max, 10,000 injected per turn. Leads write via `remember_project` / `consolidate_project_memory` under a revision fence; children get an index plus up to four lexical matches and cannot write; root chats get up to four recent turn reports. Tools `search_project_memory` / `read_project_memory` need no VM. This is the only cross-thread shared state, and it is notes, not files.
- Environment (`docs/project-environments.md`): the project owns a prepared private snapshot; each writer gets a separate copy; reconnecting reuses that writer's VM. So each chat has its own VM and checkout; threads share code only through git branches and PRs. Writer subagents run on forks of the thread's VM (`docs/subagent-start.md`). What side chats share with Main: not verified in this pass.
- R2 holds private checkpoints (`docs/architecture.md`). There is no shared drive, volume or per-project file store.

**(d) Isolation.** Per-user ownership on every lookup (all queries take `userId`); per-chat VM; boxes hold no production secret (`docs/turn-runner-boxes.md` "No secrets on a box"; secret values are written to the VM by the edge, boxes see names only); memory redacts known credential patterns and is labelled untrusted.

## 3. Comparison

| Capability | ytimesy | Capy |
|---|---|---|
| Worker thread messages another thread | No (`agent_send` only to own child) | Yes, when asked; arrives as steer, reply wakes sender |
| Y²/Captain messages threads | Yes: queue/steer/interrupt, same project | Yes (Captain, crew) |
| @mention | Name, id, state only | Agent can read status, PRs, history, search messages |
| Orchestrator | Y² per project (never works) | Captain per project; Captains talk to each other |
| Cross-project | No (same project only) | Captains read threads in visible projects |
| Shared files | None; git branches only | Drive: Project/Org/Personal scopes |
| Shared memory | Project memory, 120k chars, lead writes | Drive AGENTS.md and skills |
| Others' results | Y² reads reply, plan, canvases; workers no | Any thread can read full history |
| Loop protection | Y²: 8 starts/turn, 50 queued, admission | Not documented |
| Permissions | Owner only, per-user | Org members see Org/Project drives; Captain acts as owner |

## 4. Recommendation (priority order)

1. **Readable thread results for workers (S, 2–3 days, low risk).** Let a mention carry a `read_thread` tool for same-project threads: reuse Y²'s `deps.outcome` (final reply, plan, canvases), never the transcript by default, read-only, never wakes. Cost: one Postgres read per call, no DO. Risk: prompt injection from another thread's text; label it untrusted like memory.
2. **Worker `message_thread` to same-project threads (M, about 1 week, medium risk).** Reuse Y²'s path, queue mode by default, only when the user @-mentioned the thread or asked. Loop protection: a per-turn cap (like 8), a per-chat inbox cap (50 exists), a hop counter in the message so A→B→A replies stop at 2 hops, and normal admission. Messages from a thread are labelled with its name.
3. **Project drive (L, 3–4 weeks, highest risk).** Recommended first version: an R2 prefix per project (`drive/<project>/…`), accessed through edge tools `drive_list/read/write` with the project secret rule untouched (no new secret on boxes; the edge signs). Not a mounted volume: a mount across per-chat VMs needs sync, conflict handling and Freestyle support I cannot confirm. Write with an etag/If-Match so concurrent writes fail loudly instead of overwriting; keep versions (Capy keeps 24 h; suggest 7 days); limits like 100 MiB per file and a per-project quota; exclude checkout and secrets, scan for credential patterns like memory does. Later: an optional sync into `~/ytimesy-drive` on the VM, only if the tools prove too slow. Cost: R2 operations plus Worker requests per access; no DO awake time. Must be OS-independent (plain files, no Linux-only mount semantics).
4. **Surfacing (S–M).** Sidebar: show a "Messaged by <thread>" marker on a thread row and a note in the Y² status card; Y² should be told when worker-to-worker messages happen so it does not repeat them. Mention chips could show state.

**Product decisions for you (my recommendation in bold):**
- Should workers message threads without being asked? **No: only on request or @-mention, as Capy does.**
- Drive visible to other users of a shared project? **Owner only for now, matching the per-user model.**
- Mounted volume or tool-based drive? **Tool-based first.**
- Cross-project reads (Capy Captains)? **Defer.**

## 5. Not verified here
Whether side chats share a VM or checkout with Main; the R2 usage beyond checkpoints; whether Freestyle supports a shared volume across VMs; Capy cloud Drive mount behaviour.

## 6. Built (2026-11-24, branch `ytimesy/thread-to-thread-32f9e2`, not deployed)

Drive is deferred by the user's decision. Public harness: not ported (the user says the monorepo is the public one).

- `read_thread(id)` and `message_thread(id, text, mode)` for an ordinary root thread (not Y², not helpers): `src/server/services/thread-peer-tools.ts`, rules in `src/domain/thread-peer.ts`, work in `src/server/services/thread-peer-read.ts`. Same user, same project, root threads only, never itself, never Y².
- Reads and sends run where the database is: directly in the Durable Object, through the `peerThread` and `peerSend` box ports on a box (`turn-box-protocol.ts`, `turn-box-port-handlers.ts`). The box sends only the id, text and mode; user, project and chat come from the grant.
- `message_thread` modes are `queue` (default) and `steer`; there is no interrupt. It goes through the person's own send path, so concurrency, usage windows and budgets apply.
- Loop protection: at most 3 sends per turn; a turn whose latest user message is a peer message cannot send (`startedByPeerMessage`), so A→B never becomes B→A→B. The person's next message lifts it. The recipient's queue cap (50) still applies. Each send is idempotent per turn, recipient and text.
- Surfacing: the recipient's chat shows the message with a "From thread X" label (`session-timeline.tsx`). Y² learns of it through the existing crew "direct start" note, which carries the first 200 characters of the request (the peer marker is short for that reason). Not built: a sidebar row badge.
- Tests: `thread-peer-read.test.ts`, `thread-peer-tools.test.ts`, the `peerThread`/`peerSend` cases in `turn-box-ports.test.ts`, and a box check in `box-turn-e2e.test.ts`.
- Not verified live: a real turn on the Durable Object or a box; the Claude Code route (it should receive the tools through `claudeCodeBridgeToolSet`, unchecked); the Y² narration of a peer message.

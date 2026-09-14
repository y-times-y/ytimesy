# ytimesy v0

Status: UI foundation complete; Freestyle/Codex integration proof recorded. Domain: ytimesy.com. Updated: 2026-09-14.

## Goal and proof

Build a hosted interface for using a user's coding agent on their GitHub repositories. Users operate projects and agent sessions; ytimesy provisions and manages their cloud environments. The first user is Het, but authorization and records must support multiple isolated users from the beginning.

V0 is complete when Het connects a real private repository and his own agent access, completes a task, inspects the diff, uses the terminal and live preview, closes the browser without interrupting active work, reconnects, and explicitly publishes a commit and PR. A rendered UI or successful build alone does not satisfy this goal.

## Product scope

1. Sign in; install a GitHub App with selected-repository access.
2. Choose a repository and branch. Prepare a project environment snapshot (dependencies, project configuration, and necessary credentials). Each agent session then gets its own Freestyle VM copied from that snapshot.
3. Connect agent access through that provider's supported sign-in. Offered v0 agents are Codex, Claude, and OpenCode. ytimesy is the host; none of these is the product. Validate each official protocol before claiming support. Claude Code must stay unmodified; each user authenticates with their own Claude account or API key inside that binary. Do not offer Claude.ai login inside ytimesy, intermediate Anthropic billing, or use Anthropic marks as ytimesy branding. OpenCode is the path when the user does not want a Codex or Claude Code subscription: run OpenCode in the workspace (`opencode serve`) and load models from that agent, including OpenCode Zen's currently free models. Do not hardcode a free-model catalog, silently fall back to paid inference, or use OpenCode to launder a Claude Pro subscription.
4. Start and steer an agent session. Show messages, tool activity, progress, approvals, cancellation, and actionable failures.
5. Inspect that session's workspace through Diff, Terminal, and Preview. The terminal is explicitly required in v0.
6. Continue active work independently of the web application request or browser connection. Reconnect to retained sessions; expose expired authentication and recovery states clearly.
7. Offer explicit commit, push, and create-PR actions. Do not silently publish or fall back to paid API inference.

Workspace isolation: a Project owns a prepared environment (Rigkit apply / clone-and-install, then a Freestyle snapshot or a warm spare that agents never edit). That template is shared; the running checkout is not. Each agent session owns a WorkspaceId: a distinct Freestyle VM copied from the template (`vms.create({ snapshotId })` or `vm.fork()` of the unused warm spare). Isolation is the VM copy, not git worktrees on one disk. Competing agents run in parallel, each with its own working tree, index, ports, PTY, and preview. Reconnect to an existing session pauses/resumes that same VM. Starting another agent copies again from the clean template — never from an agent VM that already has edits. Each workspace checkout uses its own branch for publication.

Project context is an agent-context concern, not a VM concern and not a Codex-only concern. Agents under the same Project share a durable briefing plus captured reasoning traces from sibling sessions, including across Codex, Claude, and OpenCode. Persist those on the Project in ytimesy records. Each provider adapter injects the relevant traces into that agent's session so the next agent can reuse how something was figured out, not only a compacted fact list. Still a new session per agent — do not share a live chat. Inject related traces (same area of the repo, related task), not every thought from every session. After a session, keep the traces and a short briefing update; do not require the other agent to replay the full transcript. Resume continues one session; forking a conversation is explicit, not how every new agent starts.

Environment speed is separate from context. A new agent VM is a copy of an already-prepared project snapshot (`vm.fork()` or `vms.create({ snapshotId })`), so opening another agent does not run setup. The first project setup must still be fast: boot a prebaked tools image (Node, git, Codex CLI, Claude Code CLI, OpenCode CLI, package store — no user secrets), apply that user's private per-provider auth snapshot, then clone and install with warm caches, and snapshot immediately. Do not install OS tooling per project, do not copy Cursor hourly Builds as the user-visible wait, and do not block a second agent on `pnpm install`. Composer can bind as soon as that session's VM is reachable.

Do not put two agents in one checkout, use git worktrees to fake isolation, serialize competing edits on a shared VM, or re-run `pnpm install` when opening a new agent.

Later: local session import/handoff, agents beyond Codex, Claude, and OpenCode, non-Git folders, fresh project/repository creation, advanced collaboration, automations, and billing UI. Preserve clean extension boundaries without implementing speculative features.

## Experience and visual direction

Left sidebar: projects and sessions. Collapse it into a persistent narrow rail with a logo placeholder and expand control; never remove it entirely. Hovering over the rail temporarily reveals the sidebar over the workspace; moving away closes it. Clicking the expand control pins it open. Center: conversation, activity, composer, task controls. Right: resizable, expandable Diff / Terminal / Preview tabs. Provide focused empty states and guided setup rather than a decorative dashboard. Before a project is connected, collapse the inspector by default and expose it through Tools. The product flow is homepage → onboarding → workspace. Repository connection and agent authentication belong in onboarding and project setup, not in the task composer. The composer contains a compact task draft, model selection, reasoning level, file attachments, an icon toggle for Fast mode, and send. Show selected project and branch in a shallow context bar above it. The textarea grows with the draft to a capped height, then scrolls internally; omit a manual resize handle. Use a text-only model selector. Load model choices and supported reasoning/Fast capabilities from the connected agent; never invent supported model names. Do not add a universal Auto reasoning choice or assume every model has Low/Medium/High. Render the provider's ordered levels and labels, with bar count matching that model's available levels. Reset reasoning to the selected model's default on model change; disable reasoning when no model is selected or the model has no configurable levels. Until integration, settings and attachments are local draft state and sending remains unavailable. Do not fabricate account details.

ytimesy has its own monochrome visual identity: Inter interface typography from shadcn preset `b1D0dv72` (Radix Mira, neutral palette; reserve monospace for code and terminal content), black and charcoal surfaces, fine gray borders, white primary actions, deliberate spacing, and polished interaction states. Use simple 16px icons with a consistent 1.5px stroke; omit decorative icons from text tabs. Keep the workspace background plain; no artwork or shader for now. Use a compact monochrome Y silhouette made from two vertical bars of ascending height that join into one lower stem, with restrained flat grayscale facets for depth from `public/brand/mark.svg`, shown at 28px in both sidebar states. Pair it with the lowercase ytimesy wordmark in the expanded sidebar. Keep the lettering restrained, closely spaced, and off-white. The symbol should express independent work multiplying through its own geometry; do not imitate reference brand marks. Do not use starbursts, masks, mountains, PR symbols, glow, gradients, or surrounding tiles. The displayed name is ytimesy. Keep the expanded wordmark free of a separate logo tile or version badge. The project and domain remain ytimesy and ytimesy.com. Avoid green accents and literal binary-digit fields; keep the texture away from primary content. Reference screenshots remain ignored by Git. Use concise, functional UI copy. Avoid promotional headlines, taglines, and redundant onboarding prose inside the workspace. Infrastructure details appear only when they help resolve a problem.

Codex onboarding target: Connect Codex → copy a one-time code → authorize on OpenAI's page → automatically detect completion. Preserve progress and support expiry/retry/reconnection. Never ask for secrets in chat. Provider usage remains billed to the user's supported subscription or explicitly selected API account; infrastructure usage is separate.

Claude onboarding target: run unmodified Claude Code in the user's workspace VM and complete Anthropic's own sign-in in that binary. Each end user brings their own Claude subscription or API key. Do not collect Claude.ai passwords in ytimesy chat, wrap Claude.ai login in the ytimesy origin, or bill Anthropic usage through ytimesy.

OpenCode onboarding target: install OpenCode in the workspace and connect through its official server (`opencode serve`). Default path is the user's OpenCode Zen account so they can use Zen's currently free models without a Codex or Claude Code subscription; they may also attach their own provider keys or local models. Load model names from the connected agent. Some Zen free models are time-limited and may use prompts for training — surface that from the provider, do not hide it. Do not store Zen keys in shared images or bill Zen through ytimesy.

## Stack decisions

| Layer | Decision |
| --- | --- |
| Web application | TanStack Start, React, TypeScript; thin server functions and routes |
| Client server-data cache | TanStack Query |
| Application authentication | Better Auth; separate from GitHub App and agent authentication |
| Backend operations | Effect TS from day one |
| Workspace runtime | Freestyle full Linux VMs |
| Environment preparation | Rigkit; verify programmatic and web-auth integration |
| Durable application records | Managed PostgreSQL; provider not chosen |
| GitHub | GitHub App and Octokit |
| UI | Tailwind and shadcn/ui preset `b1D0dv72` (Radix Mira, neutral, Inter) |
| Terminal | xterm.js connected to the workspace PTY |
| Jobs | Durable queue and separately runnable workers; provider not chosen |
| Live transport | Reconnectable agent events; WebSockets for terminal; exact transport to validate |
| Large artifacts | Object storage; provider not chosen |

Hosting is still open. Prefer compatible, existing integrations after a small proof. No Fastify service is required for ordinary web endpoints. TanStack Start handles those; separate workers handle long-lived operations. Pin verified package versions and use a lockfile. Current docs label Start a release candidate; account for that when validating deployment.

## Modules and dependency direction

Read and apply [.agents/skills/self-documenting-code/SKILL.md](.agents/skills/self-documenting-code/SKILL.md), installed from theswerd/aicode, before implementing or reviewing code.

Start with one repository and independently runnable web/worker entry points when workers exist. Modularize by responsibility, not by making every function a package. Create modules as their first working flow is implemented:

- `src/routes`: navigation, request validation, authentication boundary, composition; no provisioning logic.
- `src/features/projects`: repository selection and project UI.
- `src/features/sessions`: conversation, activity, composer, session controls.
- `src/features/workspace`: panel layout, changes, terminal, preview.
- `src/components/ui`: shared visual primitives with no infrastructure knowledge.
- `src/domain`: precise models, branded IDs, valid state transitions, pure policies.
- `src/server/services`: Effect workflows for project setup, session lifecycle, publication, and recovery.
- `src/server/adapters`: Freestyle, Rigkit, GitHub, agent protocol, database, and job implementations. Keep provider-specific details here.
- `src/server/auth`: identity, tenant membership, repository permissions, provider-connection boundaries.
- `src/server/jobs`: durable job handlers and reconciliation, independent of request lifetime.

Dependency flow: UI → authenticated server entry → service → defined capability → adapter. Domain logic does not depend on React, HTTP, or provider SDKs. Server-only modules and credentials must not enter browser bundles. Boundary inputs are validated at runtime; external strings do not become trusted IDs merely through a cast.

### Review rules

- Small semantic functions take required inputs and return explicit outputs. Side effects are explicit responsibilities.
- Workflow functions compose steps; document non-obvious behavior such as retries, recovery, and publication boundaries.
- Model independent concepts separately. Prefer explicit state variants over unrelated optional fields.
- Distinguish UserId, ProjectId, WorkspaceId, SessionId, and JobId. A Project owns the environment template and the shared agent briefing. A Workspace is one agent VM. A Session is the conversation attached to that VM. Do not treat the briefing as VM state or collapse WorkspaceId onto ProjectId.
- Keep Effect in backend services and adapters; UI receives serializable data and actionable errors.
- Name modules for what they own. Avoid catch-all utility files, generic managers, pass-through abstraction layers, and oversized route files.
- Add an abstraction when it clarifies a real boundary, not merely to support an imagined future provider.

## Reliability and growth

Million-developer scalability is an architectural ambition, not a verified launch capacity. Registered users and concurrent VMs are different capacity measures. Establish launch concurrency targets, quotas, provider agreements, and load tests before claiming scale.

- Scope every query, command, live connection, artifact, and provider reference to its authorized owner/tenant.
- Persist job and workspace state in PostgreSQL. A web restart must not lose ownership of work.
- Provision with idempotency and reconciliation; handle a timeout after remote creation without blindly creating a second VM.
- Limit concurrency and apply backpressure. Record infrastructure usage from the beginning.
- Preserve durable event ordering/cursors for reconnect; distinguish cached UI data from the authoritative session record.
- Effect retries and finalizers do not replace durable recovery or orphan reconciliation.
- Cancellation of a run is distinct from deleting its workspace VM. Deleting one agent VM must not delete the project snapshot or other agents' VMs.
- Snapshot credentials only within explicitly isolated user state; shared base images contain no user secrets. Define logout, deletion, and credential-expiry behavior. After ChatGPT login, capture a private Freestyle VM snapshot of that user's guest (disk includes `~/.codex/auth.json`). Store the snapshot id in tenant-scoped records later; proof CLI stores it in gitignored `.ytimesy/codex-auth-snapshot.json`. Do not mark that snapshot public or bake it into a shared base image. Shared images may later include tools such as bubblewrap, but never user credentials.
- GitHub authority is repository-scoped and brokered wherever practical. Untrusted repository code must not gain platform authority.
- App previews and terminals require access control. Browser preview content is untrusted and must not inherit application-origin privileges.

## Implementation sequence

### 1. Application foundation
Scaffold TanStack Start with TypeScript, lint/typecheck/build scripts, and a clean ytimesy app shell. Introduce the first domain models and Effect service boundary through a real narrow operation. Use honest empty/unconfigured states; do not fabricate repos, sessions, or successful connections.

### 2. Integration proof
Verify official Codex remote login and app-server protocol in a user-isolated Freestyle workspace. Verify official Claude Code in the same class of workspace with user-owned credentials. Verify OpenCode `serve` and that model/list includes whatever Zen currently reports as free, without inventing names. Verify Rigkit installation/setup operations and authentication interaction. Establish supported versions and cleanup behavior. User subscription access is not interchangeable with a general inference API.

### 3. Identity, records, and GitHub
Integrate Better Auth and select Postgres hosting, implement migrations and tenant-scoped access, install GitHub App, and list authorized repositories. Save project/branch selection. Configuration requiring user/provider account access may remain a clearly reported blocker, not mocked success.

### 4. Durable workspace preparation
Implement queued creation, setup logs, retries, recovery, and state transitions. Prepare the real repo and run its app. Keep credentials out of source and logs.

### 5. Agent session and live views
Connect the supported agent protocol, stream events, persist session references, and implement approvals/cancellation/reconnect. Connect real diffs, a PTY terminal, and an authenticated app preview.

### 6. Publication and dogfooding
Implement explicit commit/push/PR actions with repository and branch checks. Run the complete acceptance flow on Het's actual project, fix failures, and record evidence and remaining limits.

## Verification

Run typecheck and production build for structural changes. Unit-test meaningful policies/state transitions; integration-test authorization, duplicate provisioning, reconnection, cancellation, and publication. Use agent-browser for real UI verification. Exercise empty, loading, denied, expired, failed, and ready states. Verify keyboard navigation, panel resize, and readable layouts. Phone use is a core requirement: retain the rail, support touch opening and dismissal of the sidebar, show the inspector within the visible main area, use 44px touch targets and at least 16px text inputs, and handle narrow screens, rotation, safe areas, and reduced viewport height. Validate 320px phones through desktop widths; browser viewport checks do not replace real-device Safari/keyboard verification. Label mocked tests, live provider checks, and untested behavior distinctly.

## Sources and known uncertainty

- Freestyle runtime: https://www.freestyle.sh/docs/vms
- Rigkit: https://www.freestyle.sh/blog/product/introducing-rigkit and https://www.rigkit.dev/docs/bash
- TanStack Start: https://tanstack.com/start/latest/docs/framework/react/overview
- Effect: https://effect.website/docs/getting-started/introduction/
- Codex auth: https://developers.openai.com/codex/auth
- Claude hosting/auth constraints: https://code.claude.com/docs/en/legal-and-compliance
- OpenCode server: https://opencode.ai/docs/server/
- OpenCode Zen (including free models): https://dev.opencode.ai/docs/zen/

Recheck versioned APIs before implementing. Validate subscription connection using the official provider protocol; a successful login alone does not establish supported execution or token lifecycle behavior. Prior research notes are historical context, not a substitute for current documentation.

## Execution status

- Research and product decisions captured; coding skill installed.
- TanStack Start foundation and workspace empty states implemented; Diff / Terminal / Preview selectors work.
- Freestyle VM create/exec/delete and Codex ChatGPT device-code login are proven in an isolated VM. See milestone 2 evidence. `model/list` returned the connected agent's models. `turn/start` completed on listed model `gpt-5.3-codex-spark` with ChatGPT subscription access (not API-key billing). A private Freestyle snapshot of that login boots later VMs already authenticated.
- Effect services and adapters exist for that proof. TanStack Query is still unused. Sending remains disabled in the UI.
- Better Auth is selected; authentication is not implemented.
- No deployed app, durable project records, GitHub listing, terminal, preview, or publication flow yet.
- Continue with milestone 3: identity, tenant-scoped records, and GitHub App repository access. The workspace UI now connects Codex through the existing app-server daemon (not ACP), loading `model/list` into the composer after a private snapshot boot. Sending a task reuses that daemon's inbox. GitHub listing, terminal, preview, and publication remain unimplemented.

## Cloud-agent handoff

### Goal

Use ytimesy to work on its own repository with a real cloud coding agent. Preserve the approved UI while building the first complete flow: sign in → connect this repository → connect Codex, Claude, or OpenCode → launch a Freestyle workspace → send a task → inspect changes, terminal, and preview → publish explicitly.

### Current evidence and limits

The workspace UI is still honest empty states. Model, reasoning, and Fast options still require a connected agent; sending stays disabled. File attachments are local draft state. Diff, Terminal, and Preview are UI shells.

Milestone 2 live check (2026-09-13):

- Freestyle SDK `0.2.13` against `https://api.freestyle.sh/v5`. Created `ytimesy-proof-*` from the default Ubuntu image with an explicit outbound-internet firewall. Guest: Linux 6.1.102 `freestyle-vm`, Python 3.12.3. Proof VMs are deleted after the check.
- Codex CLI `0.154.0` installed with `https://chatgpt.com/codex/install.sh`. `codex app-server` accepted JSON-RPC `initialize`, `account/login/start` `{ "type": "chatgptDeviceCode" }`, and after browser authorization `codex login status` reported `Logged in using ChatGPT`. Plan type from app-server: `prolite`.
- `model/list` (hidden models excluded) returned, in order: `gpt-6-astra` (GPT-6-Astra), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.3-codex-spark`. These names came from the connected agent; they were not invented in ytimesy.
- `turn/start` on listed model `gpt-6-astra` failed earlier with a ChatGPT usage limit (retry after 2026-09-19 17:57, or add credits). A later turn on listed model `gpt-5.3-codex-spark` completed with assistant text `pong`. No API-key login was used.
- After ChatGPT login, a private Freestyle snapshot (`public: false`, slug prefix `ytimesy-codex-auth-`) captured the guest including Codex CLI and `~/.codex` auth. Proof VMs were deleted. A new VM booted from that snapshot id in `.ytimesy/codex-auth-snapshot.json`, resumed ChatGPT auth without a device code, listed the same models, and completed another spark `turn/start` (`pong`). `prove:codex-login:cleanup` deletes the running VM and keeps the snapshot.
- First `account/read` immediately after device-code completion returned `account: null`; retrying `account/read` with `refreshToken: true` on a new app-server process saw the ChatGPT account. Product login must wait for that refresh, not treat the first null as logged-out.
- App-server logs a missing host `bubblewrap` and falls back to the bundled helper. That is a VM image concern for later shared base snapshots. Spark `turn/start` completed despite that warning. User ChatGPT credentials are snapshotted separately and privately (`vm.snapshot`, then `vms.create({ snapshotId })`), never into a public/shared image.
- After ChatGPT login, `pnpm prove:codex-login:status` (or `:snapshot`) captures that private snapshot. Later `pnpm prove:codex-login` boots from `.ytimesy/codex-auth-snapshot.json` and resumes Codex instead of starting a new device-code flow. `prove:codex-login:cleanup` deletes the running VM and keeps the snapshot. `codex login status` may print `Logged in using ChatGPT` on stderr; treat that as authenticated.
- Rigkit `@rigkit/sdk` / `@rigkit/provider-freestyle` `0.3.0` documents API-key auth as `freestyle.provider({ apiKey })`. It was not embedded: the SDK targets a Bun project daemon (`@effect/platform-bun`).

Better Auth, PostgreSQL records, GitHub authorization, durable jobs, live terminal/preview transports, and publication remain unimplemented. This environment currently has a PostgreSQL URL and GitHub App credentials; hosting, queue, and object-storage providers are still undecided product choices.

### Decisions to preserve

Keep the plain monochrome workspace, Inter typography, compact growing composer, responsive panels, hover-revealed sidebar rail, and model-specific reasoning controls. The approved logo is the faceted rising-bar Y in `public/brand/mark.svg`. `mark-light.svg` is light artwork for dark backgrounds; `mark-dark.svg` is dark artwork for light backgrounds. Keep the current logo and avoid restarting brand exploration.

Offered coding agents are Codex, Claude, and OpenCode. Provider protocols, login, and marks stay in adapters; do not treat ytimesy as a Codex product. Claude Code stays unmodified, with per-user credentials and a private auth snapshot separate from Codex. OpenCode is the no-Codex/Claude-subscription option; free Zen models are listed by the connected agent, not hardcoded.

Each new agent session is a new VM copied from the project's prepared snapshot or unused warm spare, not a second git worktree on a shared machine. Resume is the same VM; a second agent is another copy. Fork only from a clean template so agent B does not inherit agent A's dirty tree.

Shared project context is injected into the new agent's session, independent of that VM copy and of which provider is running. Include sibling reasoning traces, not only compacted facts.

First project setup boots a prebaked tools image (Codex, Claude Code, and OpenCode CLIs), applies the user's private provider auth snapshot, then clone/install with caches and snapshot. Later agents copy that snapshot with no setup wait.

Use the installed self-documenting-code skill. Keep routes thin and put provider operations behind explicit adapters. Do not fabricate integration success or silently substitute paid model API access for the user's subscription.

### Local setup and verification

Run `pnpm install --frozen-lockfile`, then `pnpm dev` (port 3000). To match the existing local browser, run `pnpm exec vite dev --host 127.0.0.1 --port 3001`. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before handing off structural changes. `pnpm prove:codex-login` starts a live ChatGPT device-code login unless a private auth snapshot already exists (`FREESTYLE_API_KEY` required). After authorization, `pnpm prove:codex-login:status` records that snapshot. Use agent-browser for UI checks. Screenshots and credentials must remain out of Git.

### Next step

A private Codex ChatGPT snapshot now exists for this environment; later proof VMs should boot from it instead of repeating device-code login. The workspace UI connects that snapshot through Codex app-server (`thread/start` / `turn/start`, `model/list`) rather than ACP. `turn/start` completed on listed `gpt-5.3-codex-spark`. Do not switch Codex work to API-key billing. Next: Better Auth with tenant-scoped PostgreSQL records and GitHub App repository listing. Revisit Rigkit as the environment-prep adapter only if it can run as a Node worker without substituting a different VM provider.

Provider credentials are not committed. Hosting, queue, and object-storage providers remain undecided. Do not assume a local server or an unpushed commit is available to a cloud agent: this repository must be made accessible to that environment first.

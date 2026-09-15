# ytimesy v0

Status: identity and GitHub onboarding work locally; Freestyle/Codex integration proof is recorded and the workspace UI can send Codex turns. Claude Code sign-in and OpenCode connect (`opencode serve`, no account login) dispatch on the prepared VM. Domain: ytimesy.com. Updated: 2026-09-15.

## Goal and proof

Build a hosted interface for using a user's coding agent on their GitHub repositories. Users operate projects and agent sessions; ytimesy provisions and manages their cloud environments. The first user is Het, but authorization and records must support multiple isolated users from the beginning.

V0 is complete when Het connects a real private repository and his own agent access, completes a task, inspects the diff, uses the terminal and the shared desktop, closes the browser without interrupting active work, reconnects, and explicitly publishes a commit and PR. A rendered UI or successful build alone does not satisfy this goal.

## Product scope

1. Sign in; install a GitHub App with selected-repository access.
2. Choose a repository and branch. Prepare a project environment snapshot (dependencies, project configuration, and necessary credentials). Each agent session then gets its own Freestyle VM copied from that snapshot.
3. ytimesy provides the harness. Offered harnesses are Codex, Claude Code, and OpenCode. The user picks a harness, then models from that harness. The composer currently defaults to OpenCode and, from that connected catalog, prefers a listed Zen spark/free model (today `opencode/muse-spark-1.3-contributor-free` when listed). Codex spark remains the preference when Codex models are listed. Subscription sign-in and bring-your-own API key are both options; stored keys are encrypted at rest (AES-256-GCM) and never returned in plaintext. Do not silently fall back to paid inference. Claude Code must stay unmodified; do not offer Claude.ai login inside ytimesy, intermediate Anthropic billing, or use Anthropic marks as ytimesy branding. OpenCode is the path without a Codex or Claude Code subscription, including Zen free models listed by the connected harness. Never invent model names.
4. Start and steer an agent session. Show messages, tool activity, progress, approvals, cancellation, and actionable failures.
5. Inspect that session's workspace through Diff, Terminal, and Desktop. Desktop is a shared Linux display the agent can computer-use and the user can watch and control. App preview is a window on that desktop, not a separate Tools tab. The terminal is explicitly required in v0.
6. Continue active work independently of the web application request or browser connection. Reconnect to retained sessions; expose expired authentication and recovery states clearly.
7. Offer explicit commit, push, and create-PR actions. Do not silently publish or fall back to paid API inference.

Workspace isolation: a Project owns a prepared environment (Rigkit apply / clone-and-install, then a Freestyle snapshot or a warm spare that agents never edit). That template is shared; the running checkout is not. Each agent session owns a WorkspaceId: a distinct Freestyle VM copied from the template (`vms.create({ snapshotId })` or `vm.fork()` of the unused warm spare). Isolation is the VM copy, not git worktrees on one disk. Competing agents run in parallel, each with its own working tree, index, ports, PTY, and preview. Reconnect to an existing session pauses/resumes that same VM. Starting another agent copies again from the clean template — never from an agent VM that already has edits. Each workspace checkout uses its own branch for publication.

Project context is an agent-context concern, not a VM concern and not a Codex-only concern. Agents under the same Project share a durable briefing plus captured reasoning traces from sibling sessions, including across Codex, Claude, and OpenCode. Persist those on the Project in ytimesy records. Each provider adapter injects the relevant traces into that agent's session so the next agent can reuse how something was figured out, not only a compacted fact list. Still a new session per agent — do not share a live chat. Inject related traces (same area of the repo, related task), not every thought from every session. After a session, keep the traces and a short briefing update; do not require the other agent to replay the full transcript. Resume continues one session; forking a conversation is explicit, not how every new agent starts.

Environment speed is separate from context. A new agent VM is a copy of an already-prepared project snapshot (`vm.fork()` or `vms.create({ snapshotId })`), so opening another agent does not run setup. The first project setup must still be fast: boot a prebaked tools image (Node, git, Codex CLI, Claude Code CLI, OpenCode CLI, package store — no user secrets), apply that user's private per-provider auth snapshot, then clone and install with warm caches, and snapshot immediately. Do not install OS tooling per project, do not copy Cursor hourly Builds as the user-visible wait, and do not block a second agent on `pnpm install`. Composer can bind as soon as that session's VM is reachable.

Do not put two agents in one checkout, use git worktrees to fake isolation, serialize competing edits on a shared VM, or re-run `pnpm install` when opening a new agent.

Later: local session import/handoff, agents beyond Codex, Claude, and OpenCode, non-Git folders, fresh project/repository creation, advanced collaboration, automations, and billing UI. Preserve clean extension boundaries without implementing speculative features.

## Experience and visual direction

Left sidebar: projects and sessions. Collapse it into a persistent narrow rail with a logo placeholder and expand control; never remove it entirely. Hovering over the rail temporarily reveals the sidebar over the workspace; moving away closes it. Clicking the expand control pins it open. Center: conversation, activity, composer, task controls. Right: resizable, expandable Diff / Terminal / Desktop tabs. Provide focused empty states and guided setup rather than a decorative dashboard. Before a project is connected, collapse the inspector by default and expose it through Tools. The product flow is homepage → onboarding → workspace. Repository connection belongs in onboarding and project setup. Harness choice, provider sign-in, and API-key entry live in the composer harness picker — not a separate Choose a harness card. Unsigned harnesses stay muted in that picker until that provider is actually connected. A stored key is not a signed-in harness. The composer contains a compact task draft, the harness picker, model selection, reasoning level, file attachments, an icon toggle for Fast mode, and send. An active session collapses that draft into a single-row follow-up pill. Show selected project and branch in a shallow context bar above it. The textarea grows with the draft to a capped height, then scrolls internally; omit a manual resize handle. Use a text-only model selector. Load model choices and supported reasoning/Fast capabilities from the connected agent; never invent supported model names. Do not add a universal Auto reasoning choice or assume every model has Low/Medium/High. Render the provider's ordered levels and labels, with bar count matching that model's available levels. Reset reasoning to the selected model's default on model change; disable reasoning when no model is selected or the model has no configurable levels. Until integration, settings and attachments are local draft state and sending remains unavailable. Do not fabricate account details.

ytimesy has its own monochrome visual identity: Inter interface typography from shadcn preset `b1D0dv72` (Radix Mira, neutral palette; reserve monospace for code and terminal content), black and charcoal surfaces, fine gray borders, white primary actions, deliberate spacing, and polished interaction states. Use simple 16px icons with a consistent 1.5px stroke; omit decorative icons from text tabs. Keep the workspace background plain; no artwork or shader for now. Use a compact monochrome Y silhouette made from two vertical bars of ascending height that join into one lower stem, with restrained flat grayscale facets for depth from `public/brand/mark.svg`, shown at 28px in both sidebar states. Pair it with the lowercase ytimesy wordmark in the expanded sidebar. Keep the lettering restrained, closely spaced, and off-white. The symbol should express independent work multiplying through its own geometry; do not imitate reference brand marks. Do not use starbursts, masks, mountains, PR symbols, glow, gradients, or surrounding tiles. The displayed name is ytimesy. Keep the expanded wordmark free of a separate logo tile or version badge. The project and domain remain ytimesy and ytimesy.com. Avoid green accents and literal binary-digit fields; keep the texture away from primary content. Reference screenshots remain ignored by Git. Use concise, functional UI copy. Avoid promotional headlines, taglines, and redundant onboarding prose inside the workspace. Infrastructure details appear only when they help resolve a problem.

Codex onboarding target: Connect Codex → copy a one-time code → authorize on OpenAI's page → automatically detect completion. Preserve progress and support expiry/retry/reconnection. Never ask for secrets in chat. Provider usage remains billed to the user's supported subscription or explicitly selected API account; infrastructure usage is separate.

Claude onboarding target: run unmodified Claude Code in the user's workspace VM and complete Anthropic's own sign-in in that binary. Each end user brings their own Claude subscription or API key. Do not collect Claude.ai passwords in ytimesy chat, wrap Claude.ai login in the ytimesy origin, or bill Anthropic usage through ytimesy.

OpenCode onboarding target: install OpenCode in the workspace and connect through its official server (`opencode serve`). OpenCode does not require an account login. Optional provider or Zen keys may be attached afterward. Load model names from the connected agent. Some listed free models are time-limited and may use prompts for training — surface that from the provider, do not hide it. Do not store Zen keys in shared images or bill Zen through ytimesy.

## Stack decisions

| Layer | Decision |
| --- | --- |
| Web application | TanStack Start, React, TypeScript; thin server functions and routes |
| Client server-data cache | TanStack Query |
| Application authentication | Better Auth; separate from GitHub App and agent authentication |
| Backend operations | Effect TS from day one |
| Workspace runtime | Freestyle full Linux VMs |
| Environment preparation | Rigkit; verify programmatic and web-auth integration |
| Durable application records | Supabase PostgreSQL; Free plan for initial development |
| GitHub | GitHub App and Octokit |
| UI | Tailwind and shadcn/ui preset `b1D0dv72` (Radix Mira, neutral, Inter) |
| Terminal | xterm.js connected to the workspace PTY |
| Jobs | pg-boss in PostgreSQL schema `job_queue`; separately runnable `pnpm worker` |
| Live transport | Reconnectable agent events; WebSockets for terminal; exact transport to validate |
| Large artifacts | Object storage; provider not chosen |

Hosting is still open. Prefer compatible, existing integrations after a small proof. No Fastify service is required for ordinary web endpoints. TanStack Start handles those; separate workers handle long-lived operations. Pin verified package versions and use a lockfile. Current docs label Start a release candidate; account for that when validating deployment.

## Supabase and GitHub workflow

Decision recorded 2026-09-13: use Supabase PostgreSQL on the Free plan initially. Better Auth remains the application authentication system. Access PostgreSQL from server-side modules through `DATABASE_URL`; Supabase Auth and the Data API are not required by this architecture.

### Integration settings

The intended Supabase GitHub integration configuration is:

| Setting | Value |
| --- | --- |
| Repository | `y-times-y/ytimesy` |
| Working directory | `.` (parent of the root `supabase/` directory) |
| Production branch | `master` |
| Automatic branching | Off initially; preview databases have separate pricing/plan requirements |
| Deploy to production | Off until migrations and validation are working and the user enables deployment |

This integration manages database changes from this repository. It is separate from the ytimesy GitHub App that grants users access to their coding repositories. Linking the repository alone is not authorization to enable automatic production deployment.

### Migration ownership

Initialize and commit `supabase/config.toml` and ordered SQL files under `supabase/migrations/` when implementing the database. The CLI configuration is initialized. Migrations `20260913010000_enable_automatic_rls.sql` and `20260913193000_identity_and_projects.sql` are applied. The latter contains Better Auth, encrypted GitHub connections, single-use OAuth state, and personal project records. Capture any existing application schema before introducing migrations; inspect the actual database rather than assuming it is empty. Treat migrations as the authoritative schema history, including Better Auth tables and job-system setup. pg-boss creates and migrates its own tables inside the `job_queue` schema at process start; application migrations only create that schema and revoke Data API access. Do not copy pg-boss DDL into `supabase/migrations/`. Account for libraries that create or migrate their own schemas so two independent mechanisms do not race or diverge.

For a schema change, add a new migration, verify it against a disposable development database, and review it with the application changes. Preserve already-applied migrations. Keep production data and credentials out of migration/seed files. Preview branches rebuild schema from committed migrations and optional seeds; they do not automatically copy production schema or data.

Before enabling automatic production deployment, validate clean schema creation and upgrades from the preceding schema, establish a required migration check in GitHub, and document recovery for failed migrations. Supabase's production deployment option applies new migrations and configured functions/storage buckets when commits reach the configured production branch. Treat enabling it as a separate deployment decision.

### Connection and setup status

For initial local development and the persistent worker, request the dashboard's Session pooler URL (port 5432) in the ignored `.env` as `DATABASE_URL`; this supports IPv4 and session state. Use a direct connection where required by migration tooling and where network connectivity permits. Configure TLS and bounded connection pools explicitly. Keep credentials server-only; never commit or print connection URLs.

Supabase CLI 2.117.0 is authenticated and linked to `exampledevprojectref`. The initial public schema was empty. Migration `20260913010000_enable_automatic_rls.sql` was applied with `supabase db push --linked`. A live create-table probe confirmed automatic RLS; the probe transaction was rolled back. The ignored `.env` now uses the project's session pooler with `sslmode=verify-full` and `sslrootcert=.secrets/supabase-ca.crt`; node-postgres connectivity was verified. The Supabase CA certificate is local and ignored; configure a trusted CA path explicitly in deployment. RLS enablement is not a substitute for application tenancy checks and policies, especially for privileged database roles. The dashboard GitHub integration remains unverified. Confirm their actual state before reporting setup complete. The intended project security settings are Data API off, automatic table exposure off, and automatic RLS enabled if available; migrations must still define the application's authorization and database grants.

Reference: [Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration), [PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres). Recheck feature eligibility and pricing before enabling preview branches.

## Modules and dependency direction

Read and apply [.agents/skills/self-documenting-code/SKILL.md](.agents/skills/self-documenting-code/SKILL.md), installed from theswerd/aicode, before implementing or reviewing code.

Start with one repository and independently runnable web/worker entry points when workers exist. Modularize by responsibility, not by making every function a package. Create modules as their first working flow is implemented:

- `src/routes`: navigation, request validation, authentication boundary, composition; no provisioning logic.
- `src/features/projects`: repository selection and project UI.
- `src/features/sessions`: conversation, activity, composer, session controls.
- `src/features/workspace`: panel layout, changes, terminal, desktop.
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
- Snapshot credentials only within explicitly isolated user state; shared base images contain no user secrets. Define logout, deletion, and credential-expiry behavior. After ChatGPT login, capture a private Freestyle VM snapshot of that user's guest (disk includes `~/.codex/auth.json`). The signed-in app stores that snapshot id in `agent_account`; proof CLI still uses gitignored `.ytimesy/codex-auth-snapshot.json`. Do not mark that snapshot public or bake it into a shared base image. Shared images may later include tools such as bubblewrap, but never user credentials.
- GitHub authority is repository-scoped and brokered wherever practical. Untrusted repository code must not gain platform authority.
- App previews and terminals require access control. Browser preview content is untrusted and must not inherit application-origin privileges.

## Implementation sequence

### 1. Application foundation
Scaffold TanStack Start with TypeScript, lint/typecheck/build scripts, and a clean ytimesy app shell. Introduce the first domain models and Effect service boundary through a real narrow operation. Use honest empty/unconfigured states; do not fabricate repos, sessions, or successful connections.

### 2. Integration proof
Verify official Codex remote login and app-server protocol in a user-isolated Freestyle workspace. Verify official Claude Code in the same class of workspace with user-owned credentials. Verify OpenCode `serve` and that model/list includes whatever Zen currently reports as free, without inventing names. Verify Rigkit installation/setup operations and authentication interaction. Establish supported versions and cleanup behavior. User subscription access is not interchangeable with a general inference API.

### 3. Identity, records, and GitHub
Integrate Better Auth with Supabase PostgreSQL, implement migrations and tenant-scoped access, install GitHub App, and list authorized repositories. Save project/branch selection. Configuration requiring user/provider account access may remain a clearly reported blocker, not mocked success.

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
- Research and product decisions captured; coding skill installed.
- TanStack Start foundation and workspace empty states implemented; Diff / Terminal / Desktop selectors work.
- Better Auth GitHub sign-in, encrypted GitHub App connections, repository/branch selection, and owner-scoped project records are implemented and verified locally.
- Durable per-user workspace records, pg-boss jobs in the `job_queue` schema, GitHub disconnect, and Codex account persistence (snapshot id sealed, never returned to the browser) are implemented. Adding a project queues workspace preparation. The worker clones the authorized branch and installs lockfile dependencies through a `WorkspaceRuntime` capability. The worker uses Freestyle when `FREESTYLE_API_KEY` is set; otherwise it stays on the unconfigured host. Rigkit is not embedded: `@rigkit/sdk` 0.3.0 requires a Bun daemon, so preparation is Freestyle clone-and-install.
- Freestyle VM create/exec/delete and Codex ChatGPT device-code login are proven in an isolated VM. The workspace UI connects Codex through the existing app-server daemon (not ACP) on the signed-in user's prepared workspace VM, loading `model/list` into the composer after that machine is running. Sending a task reuses that daemon's inbox. Rigkit was not embedded. The Terminal tab attaches xterm.js to a reconnectable workspace PTY through a same-origin WebSocket proxy. Create pull request commits and pushes the live checkout, then opens a draft PR. Claude Code sign-in runs unmodified `claude` on the prepared VM. OpenCode connects through `opencode serve` with no account login.

Live dogfood on `y-times-y/ytimesy` (2026-09-15): installation-token clone and `corepack pnpm install --frozen-lockfile` (nvm-sourced) reached workspace `ready`. PTY slug `main` reattached (`created: false`) and echoed `ytimesy-reconnect-proof`. Desktop reported `running` with a viewer on display `:0`. `publishProject` opened draft PR https://github.com/y-times-y/ytimesy/pull/7 (`DOGFOOD_PROOF.md`). OpenCode Zen model `opencode/muse-spark-1.3-contributor-free` completed a turn (`pong`) and wrote `DIFF_PROOF.md`; the Diff inspector now reads that working tree. Codex resumed ChatGPT auth from the user's private snapshot (plan `prolite`) but listed models hit the ChatGPT usage limit, and `gpt-5.3-codex-spark` returned 400 on this Plus/prolite account (`The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account`). Composer therefore defaults to OpenCode Zen for now. Browser check: `/` hydrates to Sign in after the xterm SSR fix; GitHub OAuth was not completed in this cloud browser, so the signed-in workspace UI was not clicked end-to-end. Claude Code live sign-in is still pending. Conversation items remain process-local to the web server.
- Continue by connecting durable workspace jobs to the Freestyle adapters, storing Codex snapshot ids per signed-in user, and validating Rigkit.

## Cloud-agent handoff

### Goal

Use ytimesy to work on its own repository with a real cloud coding agent. Preserve the approved UI while building the first complete flow: sign in → connect this repository → choose a harness (Codex, Claude Code, or OpenCode) → launch a Freestyle workspace → send a task → inspect changes, terminal, and desktop → publish explicitly.

### Current evidence and limits

The workspace UI can load Codex models and send turns through the app-server daemon on the signed-in user's prepared workspace VM. Better Auth, PostgreSQL records, GitHub repository authorization, durable workspace jobs, and per-user agent-account records also work on this branch. The Terminal tab proxies a reconnectable PTY on that VM. Create pull request commits and pushes from the live checkout, using a workspace branch when the project is on the default branch, then opens a draft PR. Closing the browser leaves the VM running; reload resumes the same machine, PTY slug `main`, Codex login, and a desktop already listening on 6080. Claude Code sign-in runs unmodified `claude auth login --claudeai` on that VM and opens Anthropic's own URL; a stored API key is applied only after `claude auth status` accepts it. OpenCode starts official `opencode serve` with no account login, loads model names from `/config/providers`, and attaches working-tree file changes to Diff. The composer defaults to OpenCode and prefers a listed Zen spark/free model from that catalog. Conversation items are still process-local to the web server.

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

### Decisions to preserve

Keep the plain monochrome workspace, Inter typography, compact growing composer, responsive panels, hover-revealed sidebar rail, and model-specific reasoning controls. The approved logo is the faceted rising-bar Y in `public/brand/mark.svg`. `mark-light.svg` is light artwork for dark backgrounds; `mark-dark.svg` is dark artwork for light backgrounds. Keep the current logo and avoid restarting brand exploration.

Offered harnesses are Codex, Claude Code, and OpenCode. Pick a harness, then its models. Subscription sign-in and encrypted BYOK are both options. Desktop replaces Preview in Tools: a shared display for computer use that the user can also control.

Each new agent session is a new VM copied from the project's prepared snapshot or unused warm spare, not a second git worktree on a shared machine. Resume is the same VM; a second agent is another copy. Fork only from a clean template so agent B does not inherit agent A's dirty tree.

Shared project context is injected into the new agent's session, independent of that VM copy and of which provider is running. Include sibling reasoning traces, not only compacted facts.

First project setup boots a prebaked tools image (Codex, Claude Code, and OpenCode CLIs), applies the user's private provider auth snapshot, then clone/install with caches and snapshot. Later agents copy that snapshot with no setup wait.

Use the installed self-documenting-code skill. Keep routes thin and put provider operations behind explicit adapters. Do not fabricate integration success or silently substitute paid model API access for the user's subscription.

### Local setup and verification

Run `pnpm install --frozen-lockfile`, then `pnpm dev` (port 3000). To match the existing local browser, run `pnpm exec vite dev --host 127.0.0.1 --port 3001`. Run `pnpm worker` in a second process to drain workspace-preparation jobs. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before handing off structural changes. `pnpm prove:codex-login` starts a live ChatGPT device-code login unless a private auth snapshot already exists (`FREESTYLE_API_KEY` required). After authorization, `pnpm prove:codex-login:status` records that snapshot. Use agent-browser for UI checks. Screenshots and credentials must remain out of Git.

### Next step

Identity and authorized GitHub repository selection work locally. Durable workspace records queue `prepare-workspace`; the worker provisions a workspace VM when `FREESTYLE_API_KEY` is set, cloning with a GitHub App installation token and installing through corepack + nvm. New machines boot from the signed-in user's sealed Codex snapshot when one exists; an already-created VM does not pick that snapshot up automatically. Codex turns on this prepared VM are blocked until the ChatGPT usage limit resets (2026-09-19 17:57), credits are added, or Spark is entitled on a Pro ChatGPT account. The composer defaults to OpenCode and prefers listed Zen spark/free models from the connected catalog. OpenCode on the same VM completed a live turn and Diff listing. Next: sign in through the browser on this ready workspace, inspect Diff / Terminal / Desktop as the signed-in user using OpenCode Zen, and dogfood Claude Code. Draft publish proof: https://github.com/y-times-y/ytimesy/pull/7 (safe to close).

Provider credentials and account-side configuration are not included in the repository. Supabase is selected for PostgreSQL. Hosting, queue, and object-storage providers remain undecided. Do not assume a local server or an unpushed commit is available to a cloud agent: this repository must be made accessible to that environment first.


### Integration proof progress — 2026-09-13

The operator runner and recovery commands are in [scripts/cloud-proof/README.md](scripts/cloud-proof/README.md). Use that guide when continuing the first live Codex task. `pnpm cloud:proof status` refreshes actual state; this record is not proof that an ephemeral VM still exists.

Verified live: the configured Freestyle API key lists VMs and creates `ytimesy-codex-proof` from `freestyle/ubuntu-sm` (2 CPU, 4 GiB RAM). Remote Node 24.20.0 and Git 2.43.0 work. Codex 0.152.1 installed under the guest ubuntu user's directory. Its device-auth flow returns an OpenAI authorization code. The app-server initialize/account-read flow works; the test correctly fails before inference while signed out. Het completed device authorization. A live turn using the discovered default model `gpt-5.6-sol` completed and wrote exactly `ytimesy cloud proof` plus a newline to `proof.txt`. The runner read the file independently and verified its exact contents. No API key fallback was used.

The runner performs a bounded file-edit proof after login and verifies the resulting file. The VM has a 24-hour deletion deadline and 30-minute per-run cap. The guest authentication state belongs only to this isolated proof. Rigkit execution and process reconnect remain unverified. This proof does not wire the UI or implement durable production workflows.

Pause/resume was verified after the successful turn: ChatGPT login remained valid, and the proof file retained its exact content. Final VM state was confirmed `paused`. The 24-hour deletion deadline remains active; this is a disposable proof, not durable user storage. Lint, TypeScript, and production build passed. No commit or deployment was made.


### Identity and repository onboarding — 2026-09-13

Implemented Better Auth 1.7.4 with PostgreSQL-backed sessions and rate limiting. GitHub OAuth App sign-in requests only `user:email`; its pre-existing callback remains configured. The new exact local callback is `http://127.0.0.1:3001/api/auth/callback/github`. GitHub App repository connection is separate, with callback `http://127.0.0.1:3001/api/github/callback`, user-bound single-use state, PKCE, matching GitHub identity, and encrypted tokens. Refresh rotation is serialized with a database row lock; revoked access returns a reconnection error. Configure production HTTPS callbacks before deployment.

Repository discovery uses the GitHub App user token, so GitHub enforces the intersection of user and installation access. Only unsuspended installations with write access and writable, nonarchived repositories are offered. Project creation repeats this authorization check and verifies the branch against GitHub before saving. A personal tenant is the Better Auth user for v0; project queries and credential queries always include its ID. Table RLS and revoked Data API grants deny client access. The server's privileged database connection still requires these explicit ownership checks; RLS is not being represented as protection against bugs in privileged server code.

Live evidence: Het signed in through GitHub, authorized the ytimesy Cloud app, selected `y-times-y/ytimesy` and `master`, saved the project, and saw it restored after a browser reload. The installation returned only that repository. Supabase schema verification found no missing Better Auth tables/columns. Signed-out project access returned 401; a cross-origin mutation returned 403. The client production bundle contained none of the configured secret values. This identity branch now also includes the Task initiation session UI: Codex composer, harness picker, Diff from file changes, and Desktop. Production VM provisioning from the signed-in app, live terminal transport, and Claude/OpenCode sign-in remain incomplete.

Validation: tests cover migration/RLS, owner isolation, missing owners, request origins, OAuth state ownership/replay/expiry, mismatched GitHub accounts, unauthorized repositories, missing branches, workspace duplicate-provision policy, token redaction, and sealed agent-account snapshot ids. These use a disposable PGlite database and mocked GitHub responses; the real onboarding evidence above is separate. Typecheck, lint, and production build pass. Agent-browser verified the signed-out screen at 320px; authenticated flow was verified in Comet. Real-device Safari and expired-token refresh against GitHub remain untested. Better Auth's migration inspector warns about its own generated bigint rate-limit field (`lastRequest`); it reports no missing schema and live auth works.

Run `pnpm dev` for the environment-loaded server on port 3001 and `pnpm worker` to drain prepare-workspace jobs. GitHub App `[REDACTED]` is installed on organization `y-times-y` with selected access to this repository. The database migration was pushed with the existing database password supplied to the CLI through its environment after its temporary-login-role API failed. Do not expose that password in process arguments or commit it.

### Durable workspace records and identity follow-through — 2026-09-13

Added owner-scoped `workspace`, `workspace_event`, and `agent_account` tables plus the `job_queue` schema for pg-boss. Saving a project queues `prepare-workspace`. The worker claims one workspace per project, records a provider ref before further work, reuses a machine found by slug after a timeout, clones with the GitHub token only in git config env, and installs from the detected lockfile. Snapshot ids for Codex are sealed per user and omitted from `/api/account`. GitHub disconnect deletes stored App credentials without signing the user out. Freestyle VM creation is behind `WorkspaceRuntime`; the worker uses `FreestyleWorkspaceRuntime` when `FREESTYLE_API_KEY` is set.

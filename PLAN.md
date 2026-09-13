# ytimesy v0

Status: identity and repository onboarding verified locally; cloud execution is still an operator proof. Domain: ytimesy.com. Updated: 2026-09-13.

## Goal and proof

Build a hosted interface for using a user's coding agent on their GitHub repositories. Users operate projects and agent sessions; ytimesy provisions and manages their cloud environments. The first user is Het, but authorization and records must support multiple isolated users from the beginning.

V0 is complete when Het connects a real private repository and his own agent access, completes a task, inspects the diff, uses the terminal and live preview, closes the browser without interrupting active work, reconnects, and explicitly publishes a commit and PR. A rendered UI or successful build alone does not satisfy this goal.

## Product scope

1. Sign in; install a GitHub App with selected-repository access.
2. Choose a repository and branch. Prepare a persistent Freestyle workspace with dependencies, project configuration, and necessary credentials.
3. Connect agent access through the provider's supported sign-in flow. Begin with Codex as the first integration candidate; validate remote authentication and app-server behavior before claiming support.
4. Start and steer an agent session. Show messages, tool activity, progress, approvals, cancellation, and actionable failures.
5. Inspect the same workspace through Diff, Terminal, and Preview. The terminal is explicitly required in v0.
6. Continue active work independently of the web application request or browser connection. Reconnect to retained sessions; expose expired authentication and recovery states clearly.
7. Offer explicit commit, push, and create-PR actions. Do not silently publish or fall back to paid API inference.

Initial allocation: one persistent workspace per project. Serialize conflicting agent runs in that workspace until separate workspaces are implemented. Session history may contain multiple tasks; it is not a license to run competing edits in one checkout.

Later: local session import/handoff, additional agents, non-Git folders, fresh project/repository creation, parallel workspaces, advanced collaboration, automations, and billing UI. Preserve clean extension boundaries without implementing speculative features.

## Experience and visual direction

Left sidebar: projects and sessions. Collapse it into a persistent narrow rail with a logo placeholder and expand control; never remove it entirely. Hovering over the rail temporarily reveals the sidebar over the workspace; moving away closes it. Clicking the expand control pins it open. Center: conversation, activity, composer, task controls. Right: resizable, expandable Diff / Terminal / Preview tabs. Provide focused empty states and guided setup rather than a decorative dashboard. Before a project is connected, collapse the inspector by default and expose it through Tools. The product flow is homepage → onboarding → workspace. Repository connection and agent authentication belong in onboarding and project setup, not in the task composer. The composer contains a compact task draft, model selection, reasoning level, file attachments, an icon toggle for Fast mode, and send. Show selected project and branch in a shallow context bar above it. The textarea grows with the draft to a capped height, then scrolls internally; omit a manual resize handle. Use a text-only model selector. Load model choices and supported reasoning/Fast capabilities from the connected agent; never invent supported model names. Do not add a universal Auto reasoning choice or assume every model has Low/Medium/High. Render the provider's ordered levels and labels, with bar count matching that model's available levels. Reset reasoning to the selected model's default on model change; disable reasoning when no model is selected or the model has no configurable levels. Until integration, settings and attachments are local draft state and sending remains unavailable. Do not fabricate account details.

ytimesy has its own monochrome visual identity: Inter interface typography from shadcn preset `b1D0dv72` (Radix Mira, neutral palette; reserve monospace for code and terminal content), black and charcoal surfaces, fine gray borders, white primary actions, deliberate spacing, and polished interaction states. Use simple 16px icons with a consistent 1.5px stroke; omit decorative icons from text tabs. Keep the workspace background plain; no artwork or shader for now. Use a compact monochrome Y silhouette made from two vertical bars of ascending height that join into one lower stem, with restrained flat grayscale facets for depth from `public/brand/mark.svg`, shown at 28px in both sidebar states. Pair it with the lowercase ytimesy wordmark in the expanded sidebar. Keep the lettering restrained, closely spaced, and off-white. The symbol should express independent work multiplying through its own geometry; do not imitate reference brand marks. Do not use starbursts, masks, mountains, PR symbols, glow, gradients, or surrounding tiles. The displayed name is ytimesy. Keep the expanded wordmark free of a separate logo tile or version badge. The project and domain remain ytimesy and ytimesy.com. Avoid green accents and literal binary-digit fields; keep the texture away from primary content. Reference screenshots remain ignored by Git. Use concise, functional UI copy. Avoid promotional headlines, taglines, and redundant onboarding prose inside the workspace. Infrastructure details appear only when they help resolve a problem.

Codex onboarding target: Connect Codex → copy a one-time code → authorize on OpenAI's page → automatically detect completion. Preserve progress and support expiry/retry/reconnection. Never ask for secrets in chat. Provider usage remains billed to the user's supported subscription or explicitly selected API account; infrastructure usage is separate.

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
- Distinguish UserId, ProjectId, WorkspaceId, SessionId, and JobId.
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
- Cancellation of a run is distinct from deleting its persistent workspace.
- Snapshot credentials only within explicitly isolated user state; shared base images contain no user secrets. Define logout, deletion, and credential-expiry behavior.
- GitHub authority is repository-scoped and brokered wherever practical. Untrusted repository code must not gain platform authority.
- App previews and terminals require access control. Browser preview content is untrusted and must not inherit application-origin privileges.

## Implementation sequence

### 1. Application foundation
Scaffold TanStack Start with TypeScript, lint/typecheck/build scripts, and a clean ytimesy app shell. Introduce the first domain models and Effect service boundary through a real narrow operation. Use honest empty/unconfigured states; do not fabricate repos, sessions, or successful connections.

### 2. Integration proof
Verify official Codex remote login and app-server protocol in a user-isolated Freestyle workspace. Verify Rigkit installation/setup operations and authentication interaction. Establish supported versions and cleanup behavior. User subscription access is not interchangeable with a general inference API.

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

Recheck versioned APIs before implementing. Validate subscription connection using the official provider protocol; a successful login alone does not establish supported execution or token lifecycle behavior. Prior research notes are historical context, not a substitute for current documentation.

## Execution status

- Research and product decisions captured; coding skill installed.
- TanStack Start foundation and workspace empty states implemented; Diff / Terminal / Preview selectors work. Effect and TanStack Query are installed but their service/data integrations are pending.
- Better Auth GitHub sign-in, encrypted GitHub App connections, repository/branch selection, and owner-scoped project records are implemented and verified locally.
- Durable per-user workspace records, pg-boss jobs in the `job_queue` schema, GitHub disconnect, and Codex account persistence (snapshot id sealed, never returned to the browser) are implemented. Adding a project queues workspace preparation. The worker clones the authorized branch and installs lockfile dependencies through a `WorkspaceRuntime` capability. Freestyle hosting, Rigkit, and Codex device-code login remain the parallel integration-proof work; this process uses an unconfigured runtime until that host is wired.
- No deployed app or complete end-to-end flow yet. Freestyle VM creation, remote execution, pinned Codex installation, and app-server handshake were verified live on 2026-09-13. ChatGPT device authorization and a real app-server file edit passed. The UI is not connected to this operator proof.
- The narrow Codex/Freestyle proof and identity/repository step passed. Continue with Rigkit validation and durable workspace preparation.

## Cloud-agent handoff

### Goal

Use ytimesy to work on its own repository with a real cloud coding agent. Preserve the approved UI while building the first complete flow: sign in → connect this repository → connect Codex → launch a Freestyle workspace → send a task → inspect changes, terminal, and preview → publish explicitly.

### Current evidence and limits

The app currently contains frontend interactions and honest empty states, not a working cloud-agent service. Model, reasoning, and Fast options require connected-agent capabilities; sending stays disabled until integration. File attachments are local draft state. Diff, Terminal, and Preview are UI shells. Better Auth, PostgreSQL records, GitHub repository authorization, durable workspace jobs, and per-user agent-account records now work. Production VM provisioning, in-app agent execution, and live transports remain unimplemented. Prior browser checks exercised the local UI; they do not prove remote authentication or execution.

### Decisions to preserve

Keep the plain monochrome workspace, Inter typography, compact growing composer, responsive panels, hover-revealed sidebar rail, and model-specific reasoning controls. The approved logo is the faceted rising-bar Y in `public/brand/mark.svg`. `mark-light.svg` is light artwork for dark backgrounds; `mark-dark.svg` is dark artwork for light backgrounds. Keep the current logo and avoid restarting brand exploration.

Use the installed self-documenting-code skill. Keep routes thin and put provider operations behind explicit adapters. Do not fabricate integration success or silently substitute paid model API access for the user's subscription.

### Local setup and verification

Run `pnpm install --frozen-lockfile`, then `pnpm dev` (port 3000). To match the existing local browser, run `pnpm exec vite dev --host 127.0.0.1 --port 3001`. Run `pnpm worker` in a second process to drain workspace-preparation jobs. Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before handing off structural changes. Use agent-browser for UI checks. Screenshots and credentials must remain out of Git.

### Next step

The isolated Codex authentication and single-request proof passed (see progress below). Identity and authorized GitHub repository selection now work locally. Durable workspace records and the prepare-workspace job exist; they wait on the Freestyle host adapter from the parallel integration-proof work. Connect the Codex device-code flow to `saveConnectedAgentAccount` so snapshot ids are stored per signed-in user instead of a local `.ytimesy/` file. Validate Rigkit setup and recovery before treating preparation as complete. Record live results and unresolved issues after each milestone.

Provider credentials and account-side configuration are not included in the repository. Supabase is selected for PostgreSQL. Hosting, queue, and object-storage providers remain undecided. Do not assume a local server or an unpushed commit is available to a cloud agent: this repository must be made accessible to that environment first.


### Integration proof progress — 2026-09-13

The operator runner and recovery commands are in [scripts/cloud-proof/README.md](scripts/cloud-proof/README.md). Use that guide when continuing the first live Codex task. `pnpm cloud:proof status` refreshes actual state; this record is not proof that an ephemeral VM still exists.

Verified live: the configured Freestyle API key lists VMs and creates `ytimesy-codex-proof` from `freestyle/ubuntu-sm` (2 CPU, 4 GiB RAM). Remote Node 24.20.0 and Git 2.43.0 work. Codex 0.152.1 installed under the guest ubuntu user's directory. Its device-auth flow returns an OpenAI authorization code. The app-server initialize/account-read flow works; the test correctly fails before inference while signed out. Het completed device authorization. A live turn using the discovered default model `gpt-5.6-sol` completed and wrote exactly `ytimesy cloud proof` plus a newline to `proof.txt`. The runner read the file independently and verified its exact contents. No API key fallback was used.

The runner performs a bounded file-edit proof after login and verifies the resulting file. The VM has a 24-hour deletion deadline and 30-minute per-run cap. The guest authentication state belongs only to this isolated proof. Rigkit execution and process reconnect remain unverified. This proof does not wire the UI or implement durable production workflows.

Pause/resume was verified after the successful turn: ChatGPT login remained valid, and the proof file retained its exact content. Final VM state was confirmed `paused`. The 24-hour deletion deadline remains active; this is a disposable proof, not durable user storage. Lint, TypeScript, and production build passed. No commit or deployment was made.


### Identity and repository onboarding — 2026-09-13

Implemented Better Auth 1.7.4 with PostgreSQL-backed sessions and rate limiting. GitHub OAuth App sign-in requests only `user:email`; its pre-existing callback remains configured. The new exact local callback is `http://127.0.0.1:3001/api/auth/callback/github`. GitHub App repository connection is separate, with callback `http://127.0.0.1:3001/api/github/callback`, user-bound single-use state, PKCE, matching GitHub identity, and encrypted tokens. Refresh rotation is serialized with a database row lock; revoked access returns a reconnection error. Configure production HTTPS callbacks before deployment.

Repository discovery uses the GitHub App user token, so GitHub enforces the intersection of user and installation access. Only unsuspended installations with write access and writable, nonarchived repositories are offered. Project creation repeats this authorization check and verifies the branch against GitHub before saving. A personal tenant is the Better Auth user for v0; project queries and credential queries always include its ID. Table RLS and revoked Data API grants deny client access. The server's privileged database connection still requires these explicit ownership checks; RLS is not being represented as protection against bugs in privileged server code.

Live evidence: Het signed in through GitHub, authorized the ytimesy Cloud app, selected `y-times-y/ytimesy` and `master`, saved the project, and saw it restored after a browser reload. The installation returned only that repository. Supabase schema verification found no missing Better Auth tables/columns. Signed-out project access returned 401; a cross-origin mutation returned 403. The client production bundle contained none of the configured secret values. Screens remain honest: agent model selection and sending are still unavailable pending the next integration.

Validation: tests cover migration/RLS, owner isolation, missing owners, request origins, OAuth state ownership/replay/expiry, mismatched GitHub accounts, unauthorized repositories, missing branches, workspace duplicate-provision policy, token redaction, and sealed agent-account snapshot ids. These use a disposable PGlite database and mocked GitHub responses; the real onboarding evidence above is separate. Typecheck, lint, and production build pass. Agent-browser verified the signed-out screen at 320px; authenticated flow was verified in Comet. Real-device Safari and expired-token refresh against GitHub remain untested. Better Auth's migration inspector warns about its own generated bigint rate-limit field (`lastRequest`); it reports no missing schema and live auth works.

Run `pnpm dev` for the environment-loaded server on port 3001 and `pnpm worker` to drain prepare-workspace jobs. GitHub App `[REDACTED]` is installed on organization `y-times-y` with selected access to this repository. The database migration was pushed with the existing database password supplied to the CLI through its environment after its temporary-login-role API failed. Do not expose that password in process arguments or commit it.

### Durable workspace records and identity follow-through — 2026-09-13

Added owner-scoped `workspace`, `workspace_event`, and `agent_account` tables plus the `job_queue` schema for pg-boss. Saving a project queues `prepare-workspace`. The worker claims one workspace per project, records a provider ref before further work, reuses a machine found by slug after a timeout, clones with the GitHub token only in git config env, and installs from the detected lockfile. Snapshot ids for Codex are sealed per user and omitted from `/api/account`. GitHub disconnect deletes stored App credentials without signing the user out. Freestyle VM creation stays behind `WorkspaceRuntime`; this worker uses the unconfigured host until that adapter is wired.

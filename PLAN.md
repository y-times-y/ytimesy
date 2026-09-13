# ytimesy v0

Status: UI foundation complete; live backend integration pending. Domain: ytimesy.com. Updated: 2026-09-12.

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

Recheck versioned APIs before implementing. Validate subscription connection using the official provider protocol; a successful login alone does not establish supported execution or token lifecycle behavior. Prior research notes are historical context, not a substitute for current documentation.

## Execution status

- Research and product decisions captured; coding skill installed.
- TanStack Start foundation and workspace empty states implemented; Diff / Terminal / Preview selectors work. Effect and TanStack Query are installed but their service/data integrations are pending.
- Better Auth is selected; authentication is not implemented.
- No deployed app, agent connection, or end-to-end provider verification yet.
- Continue with milestone 2: prove the provider/auth boundary before expanding the product.

## Cloud-agent handoff

### Goal

Use ytimesy to work on its own repository with a real cloud coding agent. Preserve the approved UI while building the first complete flow: sign in → connect this repository → connect Codex → launch a Freestyle workspace → send a task → inspect changes, terminal, and preview → publish explicitly.

### Current evidence and limits

The app currently contains frontend interactions and honest empty states, not a working cloud-agent service. Model, reasoning, and Fast options require connected-agent capabilities; sending stays disabled until integration. File attachments are local draft state. Diff, Terminal, and Preview are UI shells. Better Auth, PostgreSQL, GitHub authorization, durable jobs, VM provisioning, agent execution, and live transports remain unimplemented. Prior browser checks exercised the local UI; they do not prove remote authentication or execution.

### Decisions to preserve

Keep the plain monochrome workspace, Inter typography, compact growing composer, responsive panels, hover-revealed sidebar rail, and model-specific reasoning controls. The approved logo is the faceted rising-bar Y in `public/brand/mark.svg`. `mark-light.svg` is light artwork for dark backgrounds; `mark-dark.svg` is dark artwork for light backgrounds. Keep the current logo and avoid restarting brand exploration.

Use the installed self-documenting-code skill. Keep routes thin and put provider operations behind explicit adapters. Do not fabricate integration success or silently substitute paid model API access for the user's subscription.

### Local setup and verification

Run `pnpm install --frozen-lockfile`, then `pnpm dev` (port 3000). To match the existing local browser, run `pnpm exec vite dev --host 127.0.0.1 --port 3001`. Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before handing off structural changes. Use agent-browser for UI checks. Screenshots and credentials must remain out of Git.

### Next step

Prove supported Codex authentication and a single agent request inside an isolated Freestyle VM, including Rigkit setup where appropriate. Verify current official APIs first. Then implement identity and repository access and connect the proof through a durable service workflow. Record actual commands, versions, results, and unresolved issues here after each integration milestone.

Provider credentials and account-side configuration are not included in the repository. Hosting, managed PostgreSQL, queue, and object-storage providers remain undecided. Do not assume a local server or an unpushed commit is available to a cloud agent: this repository must be made accessible to that environment first.

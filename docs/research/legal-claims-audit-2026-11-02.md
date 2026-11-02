# Legal pages: claim-by-claim audit (2026-11-02)

Scope: `src/content/legal/terms.md`, `privacy.md`, `training-opt-in.md`
(served at /terms, /privacy, /training). Every factual statement about the
product was checked against code, not PLAN/docs. Line numbers refer to the
documents as committed with this audit.

Verdicts: **true** (code matches the old text, kept), **fixed** (text changed
to match the code), **removed** (could not be verified or was a business
placeholder; dropped per the owner's decision that ytimesy is a project, not a
company, with support@ytimesy.com as the only contact).

## Terms (terms.md)

| # | Claim | Doc line | Code evidence | Verdict |
|---|---|---|---|---|
| T1 | Acceptance by creating an account or signing in; screens say so; version and time recorded | terms 8-11 | src/features/auth/terms-consent.tsx:9-22; src/server/auth/auth.ts:43-79 (accountCreated, signedIn); src/server/adapters/legal-acceptance.ts:30-55 (source signup/signin/notice) | fixed (added "screens say this... we record") |
| T2 | Operator named as legal entity with address | terms 5-6 | n/a | removed (owner: "ytimesy", no entity/address) |
| T3 | Agents read/change code, run commands, push branches, open PRs | terms 17-19 | src/server/services/model-agent-loop.ts; src/server/adapters/github.ts (pull request creation) | true |
| T4 | Free beta, no payments, no payment details | terms 23 | no payment provider anywhere in src (grep stripe/payment: none) | true |
| T5 | 5-hour and weekly windows; "new work pauses" | terms 24-30 | src/domain/infrastructure-usage.ts:40-41 (five_hour, weekly), :133 (new work cannot start), :166 (running work stopped after grace) | fixed (limits are on cloud machine use; running work can be stopped after grace) |
| T6 | Shared beta budget can stop new machine time | terms 27-29 | src/domain/failure-message.ts:21-23 (FLEET_MONTHLY_CAP_MESSAGE) | fixed (added; was missing) |
| T7 | 18+ requirement; close account if minor | terms 40-48 | contractual; account deletion exists src/server/services/account-deletion.ts:58 | true (no age gate in code; stated as a requirement, not a check) |
| T8 | Contact addresses support@/security@/legal@ | terms 48, 58, 148, 173, 227 | only support@ytimesy.com is used by code (src/server/adapters/email.ts:75 reply-to; src/features/landing/landing-page.tsx:411; src/domain/failure-message.ts:21); security@/privacy@/legal@/dmca@ are not routed | fixed (all -> support@ytimesy.com) |
| T9 | Supported key providers incl. xAI key | terms 82-86 | src/domain/model-connection.ts:6-26 (openai, anthropic, google, openrouter, compatible; no xAI key); xAI only as subscription src/server/auth/xai-subscription.ts:23-30 | fixed (xAI listed only as Grok sign-in) |
| T10 | Subscriptions ChatGPT/Codex, Claude setup token, Grok | terms 84-86 | src/server/auth/codex-device-login.ts; src/server/adapters/claude-subscription.ts:28-37; src/server/auth/xai-subscription.ts; feature flags src/domain/claude-code-route.ts:35, src/domain/xai-subscription.ts:11-15, scripts/deploy-production.ts:166-175 | fixed ("where ytimesy offers them") |
| T11 | Keys/tokens encrypted; not placed on agent machine | terms 94-98 | sealed with purpose bindings: src/server/services/model-connections.ts:79, src/server/adapters/claude-subscription.ts:13, src/server/auth/xai-subscription.ts:24-30, src/server/auth/codex-managed-auth.ts; model calls run at the edge (scripts/production-settings.ts YTIMESY_MODEL_EXECUTION_TARGET); Claude Code VM holds a per-turn grant src/domain/claude-code-grant.ts:3-12, src/domain/claude-code-proxy.ts:7-14 | fixed (made specific; "where we send through our servers" hedge replaced by what the code does) |
| T12 | Training setting shown in onboarding, on by default, change in Settings → Privacy | terms 104-106 | src/features/workspace/training-consent-prompt.tsx:131 (useState(true)), :60-80 (saved on Continue); src/features/onboarding/first-run.tsx:77; src/features/workspace/training-consent-settings.tsx:105-145 | fixed ("saved when you continue"; stored off until then) |
| T13 | Data used when on: prompts, code/repo context, results incl. "your edits" | terms 107-110 | src/domain/training-data.ts:104-247 (user + environment parts only) | fixed (removed "your edits": not a training part; feedback kept as "feedback you give") |
| T14 | Never models' replies or model code | terms 111-112 | src/domain/training-data.ts:120-160, 236-247 (trainingExportParts drops source "model") | true |
| T15 | Off = nothing used; turning off withdraws earlier chats | terms 113-114 | src/server/adapters/training-consent.ts:62-66 (training_eligible=false on all earlier turns) | fixed (added withdrawal of earlier turns) |
| T16 | Project exclusion | terms 115 | src/server/adapters/training-consent.ts:118-140; src/features/workspace/training-consent-settings.tsx:256-300 | true |
| T17 | "Credentials and secrets are never training data" | terms (old 6) | vault credentials are not session items; secrets inside chat text/output are not redacted (training-data.ts has no redaction) | fixed (moved to privacy/training with the honest caveat) |
| T18 | GitHub sign-in reads only profile and email | terms 121 | src/server/auth/auth.ts:155-160 (disableDefaultScope, scope user:email) | true |
| T19 | App on selected repos; clone, push, PRs | terms 122-125 | src/server/adapters/github.ts:79-88; scripts/setup-github-app.mjs:29 | true |
| T20 | Agents do not merge PRs | terms 126-127 | only merge path is the user route src/routes/api/github/pull-request.ts:61-75 -> src/server/adapters/github.ts:763-790 (merges reviewed head SHA) | fixed (added that the user can merge from the panel) |
| T21 | Agents browse the web, install packages | terms 132-134 | src/server/adapters/browser-use-cli.ts; src/server/adapters/native-web-search.ts | true |
| T22 | DMCA designated agent with name/address | terms 171-175 | n/a | removed (notices to support@ytimesy.com) |
| T23 | Self-serve account deletion in Settings | terms 179 | src/features/workspace/project-settings.tsx:485-500; src/server/services/account-deletion.ts | true |
| T24 | At least [30] days' notice of shutdown | terms 182-183 | nothing in code | fixed ("we will try to tell you in the app first") |
| T25 | Governing law, venue, arbitration, class waiver | old section 16 | n/a | removed (owner decision) |
| T26 | Changes: in-app notice; email for material changes; 14-day delay | terms 210-215 | notice: src/features/auth/legal-acceptance-prompt.tsx:60-112; acceptance recorded at sign-in/notice immediately, no delay or email path | fixed (no email, no delay; continuing/dismissing accepts) |
| T27 | Survival list incl. section 16 | terms 186 | n/a | fixed (16 removed) |
| T28 | Competitor names ([competitor], [competitor]) in drafting notes | old header, sections 2, 5, 6, 14, 16 | n/a | removed |

## Privacy (privacy.md)

| # | Claim | Doc line | Code evidence | Verdict |
|---|---|---|---|---|
| P1 | Sign-in with email/password, GitHub, Google | privacy 31-33 | src/domain/identity-providers.ts:3-6; src/server/auth/auth.ts:104,155-170 (Google only if configured) | true |
| P2 | Passwords stored only as hashes | privacy 33 | Better Auth emailAndPassword (src/server/auth/auth.ts:104); auth_account.password | true |
| P3 | OAuth sign-in tokens encrypted | privacy 34 | src/server/auth/auth.ts:37-41 (encryptOAuthTokens) | fixed (added) |
| P4 | Session IP address and user agent stored | privacy 35 | supabase/migrations/20260913193000_identity_and_projects.sql (auth_session ipAddress, userAgent); auth.ts:201 cf-connecting-ip | fixed (added; was undisclosed) |
| P5 | Accepted versions recorded with time and source | privacy 35-37 | src/server/adapters/legal-acceptance.ts:30-55 | fixed (added source) |
| P6 | GitHub connection token encrypted | privacy 39-42 | src/server/auth/github-connection.ts:81-90 (seal purpose github-credentials) | true |
| P7 | Content categories | privacy 44-51 | session items src/domain/session-item.ts; project knowledge src/domain/project-knowledge.ts | fixed (added project notes) |
| P8 | Imported local agent sessions stored, .env secrets redacted by CLI | privacy 48-51 | src/server/adapters/handoff-store.ts:10-15 (sealed); packages/ytimesy-cli/README.md | fixed (added; was undisclosed) |
| P9 | Each chat has its own VM | privacy 53-57, 320-322 | src/server/services/session-workspace-machines.ts:96 (readers share parent VM); src/server/services/subagent-writer.ts:188 (writers fork their own) | fixed (read-only helpers share their chat's machine) |
| P10 | Previews private; share makes public link | privacy 59-62 | src/features/workspace/preview-inspector.tsx:14,105; src/domain/vm-edge-routes.ts:7 (pv, share) | fixed (added; was undisclosed) |
| P11 | Credentials encrypted at app level | privacy 63-69 | token vault src/server/auth/token-vault.ts; project_secret encrypted columns supabase migrations; mcp_server.sealed_headers; mcp-oauth seal | true |
| P12 | "OpenAI-compatible endpoint settings" encrypted | old privacy 1 | model_connection.base_url is plain text; only sealed_credential is encrypted | fixed (dropped endpoint settings from the encrypted list) |
| P13 | Project secrets go to the VM; keys and tokens do not | privacy 67-69 | src/server/adapters/freestyle/scrub-agent-secrets.ts (secrets on VM); edge execution + grant (see T11) | fixed (added) |
| P14 | Memory on by default; notes written from chats; embeddings | privacy 24, 70-74 | src/server/adapters/memory-settings.ts:20-26 (default "full"); src/server/adapters/memory-embeddings.ts:10 (Workers AI qwen3 embedding); dream/save on the user's route (memory-settings.ts imports chosenRoute) | fixed (default stated plainly; notes written by an agent on your model) |
| P15 | View, clear, turn off memory | privacy 73-74 | src/features/workspace/memory.fn.ts:125-139 (clear deletes repo and embeddings); src/features/workspace/memory-settings.tsx:23 (full/off) | true |
| P16 | Training setting records | privacy 76-78 | training_consent, training_consent_event (src/server/adapters/training-consent.ts:44-71) | true |
| P17 | Usage records, no payment details | privacy 80-82 | src/domain/infrastructure-usage.ts; api_turn token usage | true |
| P18 | Analytics: "small fixed set ... no file names"; examples | privacy 84-93 | src/domain/analytics.ts:8-85 (server + browser events); exceptions src/features/analytics/client.ts:44-66,100-110; harness metrics src/domain/harness-performance.ts:91-118 | fixed (added error reports, page speed, agent performance metrics; server events) |
| P19 | IP-based location lookup disabled | privacy 91 | client.ts ($geoip_disable true); src/server/adapters/analytics.ts (disableGeoip, $geoip_disable) | true |
| P20 | "We honour Do Not Track for analytics" | privacy 91-93 | client.ts respect_dnt: true (browser only); server capture ignores DNT | fixed (browser only; server events still recorded) |
| P21 | Replay only after accepting; masking/blocking; no network/console | privacy 95-100 | src/features/analytics/client.ts:39-44 (disable_session_recording, start on accept); replay-privacy.ts:5-42; /auth pages dropped replay-privacy.ts:44-58; banner replay-consent-banner.tsx | true (added: sign-in pages not recorded, previews blocked via iframe) |
| P22 | Turn replay off in Settings → Privacy, per browser | privacy 99-100 | training-consent-settings.tsx ReplayConsentRow; replay-consent.ts (localStorage) | true |
| P23 | Hosting logs | privacy 102-104 | wrangler.web.jsonc:13, wrangler.edge-executor.jsonc:24 (observability enabled) | true |
| P24 | Turnstile on email sign-up/sign-in/reset | privacy 104-105 | src/server/auth/turnstile.ts:15-21 (also resend verification) | fixed (added verification resend) |
| P25 | Email from noreply@, replies to support@ | privacy 107-108 | wrangler send_email allowed noreply@ytimesy.com; scripts/production-settings.ts AUTH_EMAIL_FROM; src/server/adapters/email.ts:75 | fixed (reply-to added) |
| P26 | Inbound mail "received by our email provider" | privacy 108-109 | Cloudflare Email Routing forwards support@ to a Gmail mailbox (ytimesy email setup, not in src) | fixed (forwarded to Google; Google added to subprocessors) |
| P27 | Cookies | privacy 111-114 | Better Auth session cookie; src/domain/*-cookie.ts (ytimesy-branches, -inspector, -open-chat, -prs, -setup-done); localStorage drafts, replay choice, PostHog persistence (client.ts persistence: "localStorage") | fixed (section added) |
| P28 | People do not read content except ... (c) training | privacy 136-138 | no export or review pipeline reads training_eligible | fixed (removed (c) and the unverifiable "access limited to personnel") |
| P29 | Legal bases incl. consent for training | privacy 140-143 | n/a (legal) | true (counsel notes removed; see open questions) |
| P30 | Training: data used, never model output, attachments/memory/imports excluded | privacy 150-163 | src/domain/training-data.ts:104-247 (attachments dropped :242-245, memory recall not part of message :107-108, handoff = model :190-198) | fixed |
| P31 | "Credentials and secrets never training data" | privacy 162-168 | vault credentials outside chats; no redaction of secrets in chat text/output | fixed (credentials kept outside chats; honest caveat for secrets inside chats) |
| P32 | Turning off withdraws earlier chats | privacy 169-171 | src/server/adapters/training-consent.ts:62-66 | fixed (was an open owner question) |
| P33 | No export exists; nothing copied | privacy 172-174 | src/domain/training-data.ts:13-16 ("No export pipeline exists yet"); training_eligible only written, never read for export | fixed (stated plainly) |
| P34 | De-identification, 30-day deletion from training store | old privacy 4 / training | no training store exists | removed (promise the code does not keep; replaced by "we will update this policy before copying") |
| P35 | Data sent to the chosen provider incl. attachments | privacy 180-182 | api-agent-image-tools.ts / message-attachments.ts (attachments passed to models) | fixed (attachments added) |
| P36 | Web search is the provider's own | privacy 188-189 | src/server/adapters/native-web-search.ts:8-16 | fixed (added) |
| P37 | ChatGPT traffic may pass through relays | privacy 193-194 | src/domain/codex-egress.ts:1-7; src/server/adapters/codex-subscription-transport.ts:364-375; scripts/deploy-production.ts:156-160 | fixed (added; was undisclosed) |
| P38 | Claude subscription grant/proxy | privacy 196-200 | src/domain/claude-code-proxy.ts:7-14; claude-code-grant.ts:3-12 | true |
| P39 | Workers AI embeddings | privacy 206-207 | src/server/adapters/memory-embeddings.ts:10,91; wrangler.edge-executor.jsonc:30 | true |
| P40 | GitHub App permissions | privacy 211-215 | scripts/setup-github-app.mjs:24-29 (contents w, pull_requests w, checks r, issues r, actions r, metadata r) | true ([OWNER: confirm] removed; added "GitHub shows the exact permissions") |
| P41 | PR repair via comments and failed checks | privacy 216-219 | src/domain/pr-repair-signal.ts; src/server/adapters/github/pr-repair-evidence.ts | true |
| P42 | Evidence pages only visible to you | privacy 223-225 | src/routes/api/projects/$projectId/evidence/$evidenceId/$file.ts:4 (owner only); src/server/adapters/pr-evidence-records.ts evidenceForOwner; src/domain/pr-evidence.ts:437 | true ([OWNER: confirm] removed) |
| P43 | Cloudflare services list | privacy 234 | wrangler.*.jsonc (Workers, DOs, send_email, artifacts, ai, vpc_networks); R2 src/server/adapters/checkpoints/r2.ts:100 (no jurisdiction set) | fixed (imported sessions, inbound email; location: chosen by Cloudflare) |
| P44 | Supabase in us-east-2 Ohio | privacy 235 | scripts/production-settings.ts:35-38 | true |
| P45 | Freestyle region | privacy 236 | src/server/adapters/freestyle/product-vm.ts:24-36 (no region parameter) | fixed ("chosen by Freestyle"; owner marker removed) |
| P46 | PostHog US | privacy 237 | client.ts:16-17, analytics.ts host us.i.posthog.com | true |
| P47 | Subprocessor advance notice "N days" | old privacy 7 | n/a | fixed ("we will update this list") |
| P48 | Who can see data | privacy 251-256 | all adapters scope by user_id; no sharing feature; previews (P10) | fixed (section added) |
| P49 | Retention: VM "stopped after about 1 hour idle" | privacy 264 | product-vm.ts:7 (pause after 180 s); src/server/adapters/freestyle/workspace-retention.ts:256 (capture after 1 h idle), :285 scrubAgentSecrets, :354 vm.delete() | fixed |
| P50 | Snapshot kept up to 90 days | privacy 265 | src/domain/workspace-retention.ts:1; workspace-retention.ts:538-570 expiry; enabled in production scripts/production-settings.ts:27-32 | true |
| P51 | Archive 30 days (was undisclosed: "delete" archives) | privacy 263, 280-286 | src/domain/archive.ts:2; src/features/sessions/agent-session.fn.ts:185; src/features/projects/project.fn.ts:38,79; purge job src/server/services/background-job-delivery.ts:143-146 | fixed (added) |
| P52 | Checkpoints, attachments encrypted, kept until delete | privacy 266 | src/server/adapters/checkpoints/storage.ts:114,284-300 | true |
| P53 | Evidence 30 days or until PR closes | privacy 267 | src/domain/pr-evidence.ts:240; src/server/services/pr-evidence-cleanup.ts:98-130; job background-job-delivery.ts:139-142 | true |
| P54 | Pending "email codes, device codes" | privacy 271 | auth_verification (links, not codes); codex/xai device login; github_oauth_state 10 min | fixed (wording) |
| P55 | Sessions retention | privacy 270 | src/server/auth/auth.ts:189 (expiresIn 7 days) | fixed (added) |
| P56 | Training history kept after deletion | privacy 272 | src/server/adapters/account-deletion.ts:66-72; training_consent_event has no FK (supabase/migrations/20261019150000_training_consent.sql) | fixed (added; was an open owner question) |
| P57 | Account deletion deletes "usage history" | privacy 273, 288-293 | infrastructure_usage_reservation/adjustment have no FK and survive (supabase/migrations/20261003020000_infrastructure_usage.sql:7-32; 20261014050000_account_deletion_foreign_keys.sql:3-4) | fixed (ledger kept) |
| P58 | Analytics / logs / backups retention with owner numbers | privacy 274-276 | no retention configured in code | fixed (provider default wording; owner markers removed) |
| P59 | Account deletion scope | privacy 287-293 | src/server/services/account-deletion.ts:58-150 (turns cancelled, checkpoints, conversation state, evidence, imported sessions, rows, VMs, snapshots, memory repo, PostHog person) | fixed (added imported sessions, archived chats, PostHog) |
| P60 | Deletion does not uninstall App or revoke provider sign-ins | privacy 294-297 | no uninstall/revoke call in account-deletion.ts | true |
| P61 | Rights; self-serve | privacy 302-311 | no export feature in src | fixed ("no self-serve data export yet") |
| P62 | Security measures | privacy 318-324 | token vault; RLS + revoke from anon/authenticated in migrations; HTTPS (Workers) | fixed ("each chat its own VM" qualified; "traffic encrypted in transit" narrowed to HTTPS to ytimesy) |
| P63 | "Based in [country]"; EU representative | old privacy 12, Contact | n/a | removed |
| P64 | Policy change never turns training on | privacy 334-336 | consent only set by setTrainingConsent from Settings/onboarding (training-consent.ts:44) | true |

## Training (training-opt-in.md)

| # | Claim | Doc line | Code evidence | Verdict |
|---|---|---|---|---|
| R1 | Card for new accounts, switch on, saved on Continue with policy version | training 11-14 | training-consent-prompt.tsx:60-80,131; first-run.tsx:77 | true |
| R2 | Older accounts: card once; closing saves nothing, stays off | training 15-17 | training-consent.ts:83-104 (trainingPromptDue, dismissTrainingPrompt) | true |
| R3 | Off until chosen; policy change never turns it on | training 18-19 | trainingConsentFor returns TRAINING_CONSENT_OFF without a row (training-consent.ts:19-38) | true |
| R4 | Settings toggle asks to confirm on | training 20-21 | training-consent-settings.tsx:130,184-216 | fixed (added) |
| R5 | Project exclusion only shown when on, can only exclude | training 22-25 | training-consent-settings.tsx:256-300 | true |
| R6 | Eligibility fixed at turn start | training 27-28 | training-consent.ts:9-17; api-turns.ts:212-213 | true |
| R7 | Included parts | training 32-41 | training-data.ts:104-210 | fixed ("feedback, if we add it" -> "ytimesy has no feedback control yet"; added errors, line counts) |
| R8 | Excluded parts incl. web searches, questions | training 45-63 | training-data.ts:120-128,186-198 | fixed (added web searches, questions, Google) |
| R9 | Credentials "excluded by design, then scrubbed again" | old training | no scrubbing code | fixed (kept outside chats; caveat for secrets inside chats) |
| R10 | De-identification steps | old training | no export or de-identification code | removed |
| R11 | Withdrawal: copied content deleted within 30 days | old training | nothing is ever copied | removed; replaced by what the code does (earlier turns marked ineligible, training-consent.ts:62-66) |
| R12 | Account deletion withdraws; history kept | training 103-105 | account-deletion.ts:66-72 | true |
| R13 | "No export pipeline exists" | training 87-92 | training-data.ts:13-16 | fixed (moved from internal spec to a public section) |
| R14 | Published "Copy" section (UI strings) | old training | UI copy lives in code | removed from the page |
| R15 | Settings tooltip promised secret removal and 30-day deletion | src/features/workspace/training-consent-settings.tsx:88 | no export exists | fixed (tooltip now: stored keys/secrets and attachments never included; nothing copied yet; off stops immediately for earlier chats too) |

## Totals

- Claims checked: 107 (Terms 28, Privacy 64, Training 15).
- True as written: 39.
- Fixed to match code: 59.
- Removed: 9 (T2 entity/address, T22 DMCA agent, T25 governing law and
  arbitration, T28 competitor names, P34 training-store de-identification and
  deletion, P63 country/EU representative, R10 de-identification steps, R11
  30-day deletion of copied data, R14 the published UI-copy section).

## Placeholders

None remain. Owner decision (2026-11-02): ytimesy is a project, not a
company. Operator is "ytimesy"; contact for support, privacy and legal is
support@ytimesy.com; governing law, venue, arbitration and class waiver were
removed; copyright notices go to support@ytimesy.com. `[DATE]` became
2026-11-02. A test (src/features/legal/legal-page.test.tsx) fails if any
`[OWNER`, `[COUNSEL`, `{{`, `[DATE]` or competitor name reaches a published
page.

## Things the owner should know

- **PostHog deletion on account delete** works only when production has
  `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`
  (scripts/production-settings.ts:66-72); otherwise the policy's "asks PostHog
  to delete" is not true. Set both before launch.
- **support@ytimesy.com** is the only routed address used; privacy@,
  security@, legal@ and dmca@ are not routed, so the pages no longer use them.
- **Codex relays**: if production uses relay servers, they run on a host not
  named in the subprocessor table (it is not in code). Add that host if it is
  a third party.
- **Freestyle region** is not set by our code; the table says "chosen by
  Freestyle".
- **Versions** stay "2026-11-02", the same string as the earlier drafts, so
  any account that accepted an earlier draft today is not asked again. Bump a
  version on the next material change.

## Open questions for counsel (moved out of the published pages)

- Whether an on-by-default "Help improve ytimesy" switch is valid consent for
  EU/UK users (pre-ticked boxes; Planet49), or should start off there.
- Whether product events without replay can rely on legitimate interest for
  EU/UK visitors.
- Whether on-by-default training needs further California notice wording.
- Whether each subscription route (ChatGPT/Codex sign-in, Claude Code setup
  token, xAI sign-in) is allowed by that provider's terms for a hosted
  product.
- Transfer mechanisms per provider.

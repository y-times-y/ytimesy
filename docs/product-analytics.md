# Product analytics

PostHog project **ytimesy**, ID **640524**, in the separate ytimesy organization (US Cloud). The browser account differs from the existing MCP connection; the MCP connection cannot read this project until reconnected to that account. No GitHub, Supabase, or warehouse integration is required.

The official `posthog-js` SDK loads asynchronously after hydration. Analytics never gates rendering, sending, or workspace execution. Set `VITE_POSTHOG_PROJECT_TOKEN` before starting development or building a deployment. The browser sends to `/r/*` on our own origin, which the web Worker forwards to PostHog US (`src/server/web/analytics-proxy.ts`), so blockers that list PostHog's hosts or its managed proxy (`proxyhog.com`) do not drop events. Session replay's recorder is bundled and fetched only when a recording starts, so no request names `posthog-recorder.js`. The token is public and write-only; never put personal PostHog API credentials in client variables. Omit the token to disable capture.

## Initial events

| Event | Allowed properties | Meaning |
| --- | --- | --- |
| `app_viewed` | surface category | Workspace, onboarding, auth, or other; no URL |
| `prompt_submitted` | runtime, attempts | Composer submitted a request; not evidence the model succeeded |
| `inspector_opened` | panel | Files, diff, terminal, or desktop opened |

Internal user IDs identify signed-in users; logout resets identity. Anonymous IDs persist in local storage. Do Not Track is respected. Development events are labeled `environment=development`; filter them out for production analysis.

Autocapture, pageviews/pageleaves, exceptions, surveys, and feature flags are disabled. A runtime schema allowlist removes prompts, source, paths, repository names, URLs, referrers, keys, raw errors, and arbitrary SDK metadata. The public ingestion token, distinct ID, person-processing flag, environment, session/window identifiers, and GeoIP-disable flag are retained alongside allowed event properties. Replay snapshots use a separate allowlisted payload after the SDK's recorder applies the privacy controls below. The project's **Discard client IP data** setting is enabled; the SDK's deprecated `ip` option is not used. PostHog still receives network requests; disabling stored IP data is not transport-level anonymity. Initial verification events sent before enabling discard retained an IP; this setting is not retroactive.

## Session replay

Replay is off until the visitor consents (EU/UK requirement, applied to every visitor for simplicity). `disable_session_recording` is `true` at init; a bottom banner (`src/features/analytics/replay-consent-banner.tsx`, shown once per browser when PostHog is configured and Do Not Track is off) offers Accept and Decline, the choice is stored in `localStorage` under `ytimesy.replay-consent`, and Accept calls `posthog.startSessionRecording()` (also on later visits). Settings > Privacy > Session recording changes it; Decline stops a running recording. Product events and exception capture are not gated by this choice [COUNSEL: legitimate interest]. Once accepted, the official SDK masks all text before sending. Chat timelines, composer content, project lists, editors, terminal, desktop, images, inputs, and embedded frames are blocked entirely. Element attributes are allowlisted for basic layout/state; paths, link targets, titles, and accessible labels are discarded. Console logs, canvas recording, cross-origin frames, network bodies/headers, and JSON-LD are disabled. The network masking callback also removes replay navigation URLs. Head scripts and metadata are omitted with `slimDOMOptions: "all"`.

This intentionally sacrifices content-level replay fidelity to protect code, conversations, and credentials. Replays show interaction/layout, not readable chat or source. Do Not Track and the project's recording controls still apply. Review consent/privacy notices before public rollout. These controls cannot prevent sensitive information being placed in CSS classes; keep classes static and never encode user data in them.

## Server lifecycle

The official `posthog-node` SDK is lazy-loaded when configured. Set `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST=https://us.i.posthog.com` on each server/worker that handles these operations. These are separate from the browser's build-time variables. The pinned Node SDK requires Node 20.20.x or Node 22.22+.

| Event | Allowed properties | Source |
| --- | --- | --- |
| `account_created` | none | Better Auth user-record creation |
| `project_connected` | repositories | Successful project connection/save |
| `agent_created` | runtime, role | Persisted agent session |
| `turn_started` | runtime, role | Persisted transition to running |
| `turn_finished` | runtime, role, outcome, optional duration_ms | Persisted completion, failure, or cancellation |
| `environment_started` | repositories | Claimed environment build |
| `environment_finished` | outcome | Activated build or recorded build failure |
| `pull_request_created` | none | Successful creation of a draft PR |

Roles distinguish leads, writable builders, and read-only children. Duration is included only when persisted turn timing supplies a completion timestamp; untimed legacy messages are not guessed. These are operational status metrics, not evidence that the resulting code is correct. Reused environments and preparation failures before claiming a build are not build events.

Server events use internal user IDs and schema-allowlisted metadata only. Repository names, session IDs, PR URLs, prompts, credentials, and error text are not event properties. Local operation identifiers are hashed into stable event UUIDs. Repeated unchanged turn polls are ignored; this is not an exactly-once event ledger. Repeated project connections can be counted as operations rather than unique projects.

Calls run best-effort after saving operations, without awaiting telemetry in the coding path. Ingestion errors are swallowed, request timeouts are bounded, and process termination can lose pending events; there is no durable analytics outbox. Server verification events carry `environment=verification`. No prompts or traces are sent to AI observability. Review privacy disclosure and consent requirements before public rollout.

## Dashboard

[ytimesy coding activity](https://us.posthog.com/project/640524/dashboard/2160385) contains daily and weekly unique users performing `turn_started`, plus `turn_finished` counts broken down by outcome. The saved dashboard filter excludes `environment=verification`, while including development. Production-only analysis should use `environment=production`. Empty charts are expected before real events arrive; synthetic proof events deliberately do not populate them. The template's pageview, referrer, growth, and retention tiles were removed rather than presenting unrelated metrics. The dashboard stays in the existing private project; no public sharing was enabled.

References: [JavaScript configuration](https://posthog.com/docs/libraries/js/config), [Data collection controls](https://posthog.com/docs/privacy/data-collection), [Replay privacy](https://posthog.com/docs/session-replay/privacy).

## Verification (2026-10-01)

- Nine analytics tests cover initialization, required ingestion fields, privacy filtering, replay configuration/snapshot allowlisting, identification/logout, unconfigured/SSR behavior, and SDK failures. Targeted tests, typecheck, build, and changed-file Biome checks pass after enabling replay.
- Full suite after server instrumentation: 194 files passed, 905 tests passed, one skipped. Typecheck, production build, and changed-file Biome checks passed. An earlier full-suite run hit a five-second Python fixture timeout; the isolated test and full rerun passed without changing its timeout.
- Agent-browser observed an accepted HTTP 200 ingestion request and inspected the sanitized payload. The headless browser's bot filter was temporarily bypassed for this synthetic proof only, then restored; no committed bot-filter bypass exists.
- A normal Comet app visit was also performed. PostHog's event activity showed `app_viewed` and identification events, with no URL or private text in the expanded app event.
- Replay live proof: agent-browser observed a recording request to `/s/` accepted with HTTP 200. A test hook inspected the outbound snapshot after filtering: private-text canaries in both blocked and ordinary text elements were absent, as were the local page URL/hostname. The headless bot filter and compression settings were changed only for this proof and restored by reloading. This verifies the exercised DOM case, not every possible future component or production deployment.
- Server adapter live proof: two synthetic lifecycle events were accepted with HTTP 200 and independently visible in this project's event activity. This tests ingestion, not a newly executed coding task or VM build.
- Configured in local development, not deployed to a production host. Deployment must receive the public `VITE_` variables at build time and the server variables at runtime.

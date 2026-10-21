# Guest hostname for the Git proxy and realtime (production)

Status: design only, 2026-10-19. Nothing here is built or deployed. It closes
the "Guest-facing edge endpoints" open decision in `docs/production-launch.md`
and fixes the hostnames the production GitHub App and OAuth apps need.

## What needs a public hostname

| Caller | Path on the edge executor | How it is authenticated today |
|---|---|---|
| VM guests (`git fetch`/`git push` inside a user's Freestyle VM) | `/git/<owner>/<repo>.git/...` | Per-request HMAC headers (`x-ytimesy-git-grant` + signature, 60 s expiry, `GIT_PROXY_SECRET`) scoping one repository and read/write access; the executor then mints a GitHub installation token server side. The guest never holds a GitHub credential. |
| Web Worker to executor (realtime publish, job and turn admission) | `/snapshot`, `/stream`, `/turn/*`, `/jobs/start`, `/start`, `/environment/start` | Service binding `EXECUTOR` (no public network) plus signed requests (`YTIMESY_REALTIME_SECRET`, workflow secrets). |
| Executor to itself (background delivery, when no service binding is in scope) | `YTIMESY_REALTIME_URL` (= `YTIMESY_GIT_PROXY_URL` in production) | Signed requests, as above. |

So only the `/git/*` traffic strictly needs to come from outside Cloudflare,
and every request on every path is already individually signed with a
short expiry. Anything unsigned gets 401/404/503.

The user-facing app (`APP_URL`) is a separate question: it stays behind
Cloudflare Access until launch.

## Options

### A. Executor-only custom domain, app-level auth (recommended)

Attach a Workers Custom Domain, e.g. `edge.ytimesy.com`, to
`ytimesy-edge-executor-production` only. No Access in front of it.

- Security: unchanged from development, where guests already use the public
  executor URL. The signed grants are the access control; they are bound to
  one repo, one access level and 60 seconds, and the HMAC key never enters a
  VM (the server signs each grant). The hostname serves no UI and no data
  without a valid signature. The web app stays private, so the launch gate
  (no public app route) still holds.
- Operations: one DNS record managed by Cloudflare, a WAF rate-limit rule can
  sit on it, and it never has to change at launch.
- Cost of choosing it: `deploy-production.ts` currently refuses any `routes`
  in either production env; it needs one allowed exception (the executor's
  `edge.<domain>` custom domain). Optionally, harden the executor to answer
  only its known signed paths on that host and 404 everything else.

### B. Cloudflare Access with a service token

Put the hostname behind an Access application and give guests a service token
(`CF-Access-Client-Id`/`Secret` headers on every Git request).

- Every user VM would hold the token, and users run arbitrary code in their
  VMs, so any user can read it. It is effectively a shared public secret: it
  adds no protection beyond the signed grants, and one leak means rotating it
  in every VM image and running VM.
- Git needs the headers injected (`http.extraHeader`), adding a second secret
  path next to the grant headers.
- Access sits on the path of every guest Git request (latency, and a second
  failure mode for pushes).

Not recommended for guests. Access remains right for the web app before
launch.

### C. `workers.dev`

Turn on `workers_dev` for the production executor.

- Zero setup, but the deploy guard deliberately refuses `workers_dev` in
  production, the URL exposes the account subdomain, WAF and rate-limit
  rules cannot be attached, and moving off it later means changing secrets
  and redeploying. Fine for development (that is what it uses), not for
  production.

## Recommendation

Option A with `edge.ytimesy.com`, plus Access on the web app until launch.

## What the owner must create

1. **Executor hostname.** In Cloudflare (zone `ytimesy.com`, already on the
   account for email): Workers & Pages > `ytimesy-edge-executor-production` >
   Settings > Domains & Routes > Add Custom Domain `edge.ytimesy.com` (after
   the first production deploy creates the Worker). Then set
   `YTIMESY_GIT_PROXY_URL=https://edge.ytimesy.com` in
   `.secrets/production.env` (the deploy derives `YTIMESY_REALTIME_URL` from
   it). Optional: a WAF rate-limiting rule on `edge.ytimesy.com/git/*`.
2. **App hostname behind Access.** Custom Domain `ytimesy.com` (or
   `app.ytimesy.com`; it must equal `APP_URL`) on `ytimesy-web-production`,
   with a Zero Trust Access self-hosted application on that hostname allowing
   only the owner's email. Add a second Access application on the path
   `ytimesy.com/api/github/repair-events` with a **Bypass / Everyone** policy:
   GitHub's webhook deliveries cannot pass Access, and that route verifies
   GitHub's `X-Hub-Signature-256` itself (`GITHUB_PR_REPAIR_WEBHOOK_SECRET`).
   At launch, remove the main Access application; nothing else changes.
3. **Production GitHub App** (GitHub > Settings > Developer settings > GitHub
   Apps > New), with `APP_URL=https://ytimesy.com` as the example:
   - Homepage URL: `https://ytimesy.com`
   - Callback URL: `https://ytimesy.com/api/github/callback`
   - Webhook URL: `https://ytimesy.com/api/github/repair-events`, with a new
     webhook secret (`GITHUB_PR_REPAIR_WEBHOOK_SECRET`)
   - Repository permissions: Contents read and write, Pull requests read
     and write, Checks read-only, Issues read-only, Actions read-only,
     Metadata read-only (the same set as `scripts/setup-github-app.mjs`).
     Checks read lets PR repair re-read the failing check run or suite it was
     woken for; Issues read is what GitHub requires to deliver Issue comment
     events (`@ytimesy` on a pull request); Actions read lets a CI wake-up
     include the failed job's log tail (without it the wake carries check
     output and annotations only).
   - Subscribe to events: Check run, Check suite, Pull request review, Issue
     comment, Pull request review comment (the events
     `/api/github/repair-events` handles; see
     `src/server/services/pull-request-wake.ts`).
   - The existing development App was created before Checks was in the
     manifest: in GitHub > Settings > Developer settings > GitHub Apps >
     (app) > Permissions & events, set Checks to Read-only and save; each
     installation owner then accepts the new permission from the
     installation page (until then, check-failure repair cannot read the
     check and stops). Add Issues and Actions read-only and the Issue comment
     and Pull request review comment events the same way.
   - Record app id, private key, client id/secret and slug as `GITHUB_APP_*`
     / `GITHUB_PRIVATE_KEY` in `.secrets/production.env`.
4. **Production GitHub OAuth app** (sign-in): authorization callback URL
   `https://ytimesy.com/api/auth/callback/github` (`GITHUB_OAUTH_CLIENT_*`).
5. **Google OAuth client** (if Google sign-in is offered): authorized
   redirect URI `https://ytimesy.com/api/auth/callback/google`.

## Code follow-ups before deploying

- Done: `scripts/deploy-production.ts` allows exactly one production route,
  the executor's custom domain, whose host must equal
  `YTIMESY_GIT_PROXY_URL`'s and differ from `APP_URL`'s
  (`assertProductionRoutes` in `scripts/production-settings.ts`); it keeps
  refusing web routes and `workers_dev`, and requires
  `GITHUB_PR_REPAIR_WEBHOOK_SECRET`.
- `wrangler.edge-executor.jsonc` production env: add
  `"routes": [{ "pattern": "edge.ytimesy.com", "custom_domain": true }]` (or
  attach it in the dashboard as in step 1).
- Optional hardening: on the custom domain, answer only the signed executor
  paths listed above.

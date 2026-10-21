# Production launch checklist

Status as of 2026-10-14. Production stays behind Cloudflare Access with no public
route until the owner says go live. Nothing here has been deployed to production.

## Configuration

| Item | Status |
|---|---|
| Web worker `env.production` (`wrangler.web.jsonc`) | Added. Prod Hyperdrive `88d0840479284fa6ba4d75d4fb8a4d5f`, `workers_dev`/preview URLs off, `YTIMESY_ENVIRONMENT=production`. Build: `YTIMESY_TARGET=cloudflare CLOUDFLARE_ENV=production vite build`. |
| Edge executor `env.production` (`wrangler.edge-executor.jsonc`) | Added and passes `wrangler deploy --dry-run --env production`. `workers_dev` off. The deploy script must set `YTIMESY_ENVIRONMENT=production` (not a `vars` block, which breaks the generated types). |
| Guest-facing edge endpoints | **Designed, not built** (2026-10-19, `docs/guest-hostname-design.md`): an executor-only custom domain (`edge.ytimesy.com`) with no Access, relying on the per-request signed Git grants, and Access on the web app until launch (with a bypass for the GitHub webhook path). Lists the GitHub App / OAuth callback URLs and what the owner must create. |
| Deploy scripts | `scripts/deploy-production.ts` (not run yet) deploys the edge executor, then the web Worker, both `--env production`. Run: `node --env-file=.secrets/production.env --import tsx scripts/deploy-production.ts --confirm-production`. `.secrets/production.env` holds production values only. It refuses unless: the flag is passed; every required value is set (fresh `BETTER_AUTH_SECRET`, explicit `YTIMESY_SECRETS_KEY`, production GitHub App, R2, budgets, `YTIMESY_GIT_PROXY_URL`, PostHog `POSTHOG_PROJECT_TOKEN` + `VITE_POSTHOG_PROJECT_TOKEN`); `DATABASE_URL` is the production project (`vpxypoluphsggiqbfhse`, never dev); both production envs keep `workers_dev` off, the web Worker has no routes and the edge executor at most its own custom domain (exactly `[{ "pattern": <YTIMESY_GIT_PROXY_URL host>, "custom_domain": true }]`, never the app host); `GITHUB_PR_REPAIR_WEBHOOK_SECRET` is set; and no migration is pending. It derives production-only signing secrets and sets `YTIMESY_ENVIRONMENT=production` as a secret. Dev deploys stay `scripts/deploy-edge-development.ts`. |
| Migrations | Dry run `MIGRATION_DATABASE_URL=$(cat .secrets/prod-database-url) pnpm db:migrate`, then add `--apply`; the deploy script refuses while any is pending. As of 2026-10-14, applied to dev but not prod: `20261014040000_auth_email_delivery.sql` and `20261014050000_account_deletion_foreign_keys.sql`. |
| Email | Done on the account. ytimesy.com is onboarded to Cloudflare Email Sending (DKIM selector `cf-bounce`, DMARC `p=none`; tighten to `quarantine` after a clean week). Both Workers' production envs carry the `EMAIL` send_email binding, limited to `noreply@ytimesy.com`; Reply-To is support@. Email Routing forwards het@, support@ and contact@ to the owner's Gmail. |

## Secrets

Generate fresh for production; never reuse development values.

- `BETTER_AUTH_SECRET` (≥ 32 chars). Workflow, Git proxy and background secrets are derived from it, and it encrypts queued auth emails, so rotating it invalidates those.
- `YTIMESY_SECRETS_KEY`: the master key for stored project secrets and credentials. Required when `YTIMESY_ENVIRONMENT=production`. **The owner must escrow it** (password manager or offline copy) before any user data exists; a lost key orphans every stored secret.
- `FREESTYLE_API_KEY`, R2 checkpoint credentials, PostHog token.
- GitHub: a **production GitHub App** (app id, private key, client id/secret, slug, webhook secret) and OAuth app. **Owner action:** create these in GitHub; callback URLs depend on the production hostname.

## Launch basics

| Item | Status |
|---|---|
| Security headers | Done: HSTS, nosniff, same-origin framing, referrer and permissions policy on every web response. A script CSP needs nonces for TanStack hydration; not done. |
| Rate limits / abuse | Done (2026-10-19): Better Auth database rate limit (default rules); **Cloudflare Turnstile** on email sign-up, email sign-in and password reset (Better Auth `captcha` plugin, verified server side against siteverify with the APP_URL hostname; required in production via `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, off in development and tests; GitHub/Google sign-in are not challenged since they need a provider account); per-user fixed-window limits in production (`user_action_rate`, migration `20261019120000`): 20 chat sends/minute, 10 new projects/hour, 60 new VMs/hour; per-user and fleet turn concurrency; dollar-capped VM admission. Chosen over an invite allowlist because the beta is open sign-up. Optional: a Cloudflare WAF rate-limit rule on `/api/auth/*`. |
| Account deletion | Done (2026-10-14): Settings > Account, typed confirmation; deletes VMs, private snapshots, chat storage and the user (migration `20261014050000` fixes the blocking foreign keys). Not exercised on a real account yet. |
| Email | Done (2026-10-14): verification and reset mail sends from the outbox through the `EMAIL` binding, with retries; sign-up hides email when no sender is configured. Verified on dev into Gmail Primary. |
| 70% usage alert | Done (2026-10-19): users see a warning in Settings and a workspace banner at 70% of their monthly cloud minutes (and when spent); fleet cap refusals read as the beta's shared budget. |
| Error monitoring and alerts | Done (2026-10-19): server exceptions (thrown and 5xx, method and path only, redacted) and browser uncaught errors go to PostHog error tracking. The owner is emailed through the `EMAIL` binding (`YTIMESY_ALERT_EMAIL`, default het@ytimesy.com; production only, deduplicated in `owner_alert`, migration `20261019130000`) when the fleet monthly or lifetime budget reaches 80% / 95%, when turns are abandoned (lease expiry), when a scheduled job fails, and when auth emails are given up (at most hourly each). |
| Backups | Built (2026-10-19), not yet run: daily encrypted `pg_dump` to a private R2 bucket via GitHub Actions (`scripts/backup-production-db.ts`, `.github/workflows/backup-production-db.yml`) and a restore drill into a scratch database (`scripts/restore-db-backup.ts`). **Owner action:** bucket, scoped R2 token, escrowed key and repository secrets; see `docs/database-backups.md`. |
| Terms / privacy | Drafts at `/terms` and `/privacy`, bannered "Draft for review"; need counsel review. |

## Live verification on production (behind Access)

Sign-in, new chat, a turn that completes, Files and Desktop, PR panel. Not started:
production is not deployed.

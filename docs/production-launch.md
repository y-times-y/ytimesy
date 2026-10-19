# Production launch checklist

Status as of 2026-10-14. Production stays behind Cloudflare Access with no public
route until the owner says go live. Nothing here has been deployed to production.

## Configuration

| Item | Status |
|---|---|
| Web worker `env.production` (`wrangler.web.jsonc`) | Added. Prod Hyperdrive `00000000000000000000000000000001`, `workers_dev`/preview URLs off, `YTIMESY_ENVIRONMENT=production`. Build: `YTIMESY_TARGET=cloudflare CLOUDFLARE_ENV=production vite build`. |
| Edge executor `env.production` (`wrangler.edge-executor.jsonc`) | Added and passes `wrangler deploy --dry-run --env production`. `workers_dev` off. The deploy script must set `YTIMESY_ENVIRONMENT=production` (not a `vars` block, which breaks the generated types). |
| Guest-facing edge endpoints | **Open decision.** VM guests reach the Git proxy and realtime endpoints over the executor's public URL on development. Production needs a hostname for them: a route behind Access with a service token the guests carry, or a dedicated executor-only hostname. |
| Deploy scripts | `scripts/deploy-production.ts` (not run yet) deploys the edge executor, then the web Worker, both `--env production`. Run: `node --env-file=.secrets/production.env --import tsx scripts/deploy-production.ts --confirm-production`. `.secrets/production.env` holds production values only. It refuses unless: the flag is passed; every required value is set (fresh `BETTER_AUTH_SECRET`, explicit `YTIMESY_SECRETS_KEY`, production GitHub App, R2, budgets, `YTIMESY_GIT_PROXY_URL`, PostHog `POSTHOG_PROJECT_TOKEN` + `VITE_POSTHOG_PROJECT_TOKEN`); `DATABASE_URL` is the production project (`exampleprojectref`, never dev); both production envs keep `workers_dev` off with no routes; and no migration is pending. It derives production-only signing secrets and sets `YTIMESY_ENVIRONMENT=production` as a secret. Dev deploys stay `scripts/deploy-edge-development.ts`. |
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
| Rate limits / abuse | Partial: Better Auth database rate limit (default rules), per-user and fleet turn concurrency, dollar-capped VM admission. Missing: Turnstile on sign-up, a Cloudflare rate-limiting binding for chat sends and VM creation. |
| Account deletion | Done (2026-10-14): Settings > Account, typed confirmation; deletes VMs, private snapshots, chat storage and the user (migration `20261014050000` fixes the blocking foreign keys). Not exercised on a real account yet. |
| Email | Done (2026-10-14): verification and reset mail sends from the outbox through the `EMAIL` binding, with retries; sign-up hides email when no sender is configured. Verified on dev into Gmail Primary. |
| 70% usage alert | Missing. The budget ledger enforces hard limits only. |
| Backups | No plan recorded. Production is Supabase Free (no PITR); at minimum a scheduled logical dump to R2 and a tested restore. |
| Terms / privacy | Drafts at `/terms` and `/privacy`, bannered "Draft for review"; need counsel review. |

## Live verification on production (behind Access)

Sign-in, new chat, a turn that completes, Files and Desktop, PR panel. Not started:
production is not deployed.

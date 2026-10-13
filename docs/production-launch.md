# Production launch checklist

Status as of 2026-10-13. Production stays behind Cloudflare Access with no public
route until the owner says go live. Nothing here has been deployed to production.

## Configuration

| Item | Status |
|---|---|
| Web worker `env.production` (`wrangler.web.jsonc`) | Added. Prod Hyperdrive `00000000000000000000000000000001`, `workers_dev`/preview URLs off, `YTIMESY_ENVIRONMENT=production`. Build: `YTIMESY_TARGET=cloudflare CLOUDFLARE_ENV=production vite build`. |
| Edge executor `env.production` (`wrangler.edge-executor.jsonc`) | Added and passes `wrangler deploy --dry-run --env production`. `workers_dev` off. The deploy script must set `YTIMESY_ENVIRONMENT=production` (not a `vars` block, which breaks the generated types). |
| Guest-facing edge endpoints | **Open decision.** VM guests reach the Git proxy and realtime endpoints over the executor's public URL on development. Production needs a hostname for them: a route behind Access with a service token the guests carry, or a dedicated executor-only hostname. |
| Deploy scripts | Development only (`scripts/deploy-edge-development.ts`). The web worker has no recorded deploy procedure on any environment. A production script should mirror the dev one: secrets over stdin, `YTIMESY_INFRASTRUCTURE_ADMISSION=true` and the three budget vars (`YTIMESY_USER_MONTHLY_MICRO_USD`, `YTIMESY_FLEET_MONTHLY_MICRO_USD`, `YTIMESY_FLEET_LIFETIME_MICRO_USD`). |
| Migrations | Run `MIGRATION_DATABASE_URL=$(cat .secrets/prod-database-url) pnpm db:migrate` (dry run), then add `--apply`. Pending since the 2026-10-12 apply: `20261013060000_infrastructure_vm_lease.sql`, and, if branch `overnight/vm-lifecycle` is merged, `20261013100000_session_checkpoint_failure.sql` and `20261013101000_environment_build_release.sql`. |

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
| Account deletion | Missing. Blocker: `infrastructure_vm_admission.user_id` references `auth_user` without `on delete cascade`, so deleting a user fails. Deletion must also delete the user's VMs, snapshots and checkpoints. |
| Email | Missing a sender. Verification and reset emails are only queued in `auth_email_outbox`; with `requireEmailVerification`, email/password sign-ups can never verify. Wire Cloudflare Email Service to drain the outbox, or launch with GitHub/Google sign-in only. |
| 70% usage alert | Missing. The budget ledger enforces hard limits only. |
| Backups | No plan recorded. Production is Supabase Free (no PITR); at minimum a scheduled logical dump to R2 and a tested restore. |
| Terms / privacy | Drafts at `/terms` and `/privacy`, bannered "Draft for review"; need counsel review. |

## Live verification on production (behind Access)

Sign-in, new chat, a turn that completes, Files and Desktop, PR panel. Not started:
production is not deployed.

# Production database backups

Production runs on Supabase Free, which has no point-in-time recovery. A daily
logical dump is encrypted and stored in a private R2 bucket. Nothing here has
run against production yet.

## What is backed up

`pg_dump --format=custom` of the `public` schema (every ytimesy table, the
Better Auth tables included) and `supabase_migrations` (the migration record).
Supabase-managed schemas (`auth`, `storage`, ...) are not used by ytimesy and
are left out. Files in R2 (chat checkpoints, attachments, PR evidence) and
Freestyle snapshots are not part of this backup.

Each dump is sealed with AES-256-GCM (`scripts/db-backup-format.ts`: magic,
random IV, ciphertext, tag; the file name is authenticated) and uploaded as
`postgres/YYYY/MM/DD/ytimesy-production-<UTC time>.dump.enc`. The plaintext
only exists in a private temporary directory that is deleted afterwards. The
database URL travels to `pg_dump` through libpq variables, never the command
line, and is never printed.

## Schedule

`.github/workflows/backup-production-db.yml` runs daily at 09:17 UTC (and on
demand with "Run workflow") on a GitHub-hosted runner, which installs
`pg_dump` 17 and runs `scripts/backup-production-db.ts --confirm-production`.
A Cloudflare cron cannot run `pg_dump`, so GitHub Actions is the simplest
scheduler; a failed run shows in the Actions tab and GitHub emails the owner.

## Owner setup (once)

1. Create an R2 bucket for backups only, e.g. `ytimesy-db-backups`, and an R2
   API token with Object Read & Write on that bucket only.
2. Add an R2 lifecycle rule on that bucket: delete objects under `postgres/`
   after 35 days (keeps five weeks of dailies).
3. Generate the encryption key and **escrow it** (password manager plus an
   offline copy); without it no backup can be restored:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Keep a local copy in `.secrets/backup-encryption-key` for drills.
4. In GitHub, create the environment `production-backup` (optionally with
   required reviewers off, since it is scheduled) and add these secrets to it:
   - `PROD_DATABASE_URL`: the production **session pooler** URL (port 5432,
     `sslmode=verify-full`). Runners have no IPv6, so not the direct host.
   - `SUPABASE_CA_CERT`: the contents of `.secrets/supabase-ca.crt`.
   - `BACKUP_ENCRYPTION_KEY`: the key from step 3.
   - `R2_ACCOUNT_ID`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
     `R2_BACKUP_BUCKET`: from step 1.
5. Run the workflow once by hand, then do the restore drill below.

A manual backup from a laptop (needs `pg_dump` 17, e.g. `brew install
postgresql@17`): set the `R2_*` variables and run
`node --import tsx scripts/backup-production-db.ts --confirm-production`.

## Restore drill (monthly, and before trusting the backups)

Restore into a scratch database, never production or development (the script
refuses both refs). A local Postgres 17 works:

```sh
createdb restore_drill
RESTORE_DATABASE_URL=postgresql://localhost:5432/restore_drill \
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BACKUP_BUCKET=ytimesy-db-backups \
  node --import tsx scripts/restore-db-backup.ts --latest --confirm-scratch
```

It downloads the newest backup (or `--key <object key>`, or `--file <path>`
for a downloaded copy), decrypts it, runs `pg_restore --clean --if-exists
--no-owner`, and prints row counts for `auth_user`, `project`,
`agent_session` and the migration record. Compare them with production.

## Recovering production

Restore into a scratch database first and check it. To replace production
data, take a fresh backup of the current state, then restore the chosen dump
into the production database with `pg_restore` by hand (the script will not
target production); apply any migrations newer than the dump with
`pnpm db:migrate --apply`.

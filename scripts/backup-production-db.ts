/**
 * Logical backup of the production database to R2, encrypted and dated.
 * docs/database-backups.md has the schedule, the restore drill and the keys.
 *
 *   node --import tsx scripts/backup-production-db.ts --confirm-production
 *
 * Inputs (environment first, then the local file):
 * - PROD_DATABASE_URL, else .secrets/prod-database-url (never printed)
 * - BACKUP_ENCRYPTION_KEY, else .secrets/backup-encryption-key (32 bytes)
 * - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 * - SUPABASE_CA_PATH (default .secrets/supabase-ca.crt) when the URL names none
 *
 * Needs pg_dump at least as new as the server (Supabase Postgres 17).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type R2Configuration,
	r2PutObject,
} from "../src/server/adapters/checkpoints/r2";
import {
	assertProductionSource,
	BACKUP_SCHEMAS,
	backupKey,
	backupObjectKey,
	encryptBackup,
	libpqEnvironment,
} from "./db-backup-format";

const run = promisify(execFile);

async function secret(name: string, file: string) {
	const value = process.env[name]?.trim();
	if (value) return value;
	if (existsSync(file)) return (await readFile(file, "utf8")).trim();
	throw new Error(`Set ${name} or create ${file}.`);
}

export function backupR2Configuration(
	env: Readonly<Record<string, string | undefined>> = process.env,
): R2Configuration {
	const config = {
		accountId: env.R2_ACCOUNT_ID ?? "",
		accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
		secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
		bucket: env.R2_BACKUP_BUCKET ?? "",
	};
	if (
		!/^[a-f0-9]{32}$/.test(config.accountId) ||
		!config.accessKeyId ||
		!config.secretAccessKey ||
		!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
	)
		throw new Error(
			"Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BACKUP_BUCKET.",
		);
	return config;
}

async function main() {
	if (!process.argv.includes("--confirm-production"))
		throw new Error("Pass --confirm-production to back up production.");
	const databaseUrl = await secret(
		"PROD_DATABASE_URL",
		".secrets/prod-database-url",
	);
	assertProductionSource(databaseUrl);
	const key = backupKey(
		await secret("BACKUP_ENCRYPTION_KEY", ".secrets/backup-encryption-key"),
	);
	const r2 = backupR2Configuration();
	const caPath = process.env.SUPABASE_CA_PATH ?? ".secrets/supabase-ca.crt";
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-backup-"));
	const dumpPath = join(directory, "production.dump");
	try {
		try {
			await run(
				"pg_dump",
				[
					"--format=custom",
					"--no-owner",
					"--no-privileges",
					...BACKUP_SCHEMAS.map((schema) => `--schema=${schema}`),
					`--file=${dumpPath}`,
				],
				{
					env: {
						PATH: process.env.PATH ?? "",
						...libpqEnvironment(
							databaseUrl,
							existsSync(caPath) ? caPath : undefined,
						),
					},
					maxBuffer: 16 * 1024 * 1024,
				},
			);
		} catch (error) {
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			const password = new URL(databaseUrl).password;
			throw new Error(
				`pg_dump failed: ${(password ? stderr.replaceAll(password, "***") : stderr).slice(0, 2000)}`,
			);
		}
		const objectKey = backupObjectKey();
		const sealed = encryptBackup(await readFile(dumpPath), key, objectKey);
		await r2PutObject(r2, objectKey, sealed, "application/octet-stream");
		console.log(
			JSON.stringify({
				stored: `r2://${r2.bucket}/${objectKey}`,
				bytes: sealed.length,
				sha256: createHash("sha256").update(sealed).digest("hex"),
			}),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1]?.endsWith("backup-production-db.ts"))
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Backup failed.");
		process.exit(1);
	});

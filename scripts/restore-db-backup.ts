/**
 * Restores an encrypted production backup into a scratch database, to prove
 * backups work (the drill in docs/database-backups.md) or to recover data.
 * It refuses the production and development databases.
 *
 *   RESTORE_DATABASE_URL=postgres://...scratch... \
 *     node --import tsx scripts/restore-db-backup.ts --latest --confirm-scratch
 *   ... --key postgres/2026/10/19/ytimesy-production-....dump.enc
 *   ... --file ./ytimesy-production-....dump.enc
 *
 * Also needs BACKUP_ENCRYPTION_KEY (or .secrets/backup-encryption-key) and,
 * for --latest/--key, the R2_* variables used by the backup.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { r2GetObject, r2ListKeys } from "../src/server/adapters/checkpoints/r2";
import { backupR2Configuration } from "./backup-production-db";
import {
	assertScratchTarget,
	BACKUP_PREFIX,
	backupKey,
	decryptBackup,
	latestBackupKey,
	libpqEnvironment,
} from "./db-backup-format";

const run = promisify(execFile);

function option(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function sealedBackup(): Promise<{ name: string; sealed: Buffer }> {
	const file = option("--file");
	if (file) return { name: basename(file), sealed: await readFile(file) };
	const r2 = backupR2Configuration();
	const key = process.argv.includes("--latest")
		? latestBackupKey((await r2ListKeys(r2, BACKUP_PREFIX, 100_000)) ?? [])
		: option("--key");
	if (!key)
		throw new Error("Pass --latest, --key <object key> or --file <path>.");
	const response = await r2GetObject(r2, key);
	if (!response.ok)
		throw new Error(`Backup download failed (${response.status}).`);
	console.log(`Restoring r2://${r2.bucket}/${key}`);
	return { name: key, sealed: Buffer.from(await response.arrayBuffer()) };
}

async function main() {
	if (!process.argv.includes("--confirm-scratch"))
		throw new Error(
			"Pass --confirm-scratch: the target database's public schema is replaced.",
		);
	const target = process.env.RESTORE_DATABASE_URL?.trim();
	if (!target)
		throw new Error("Set RESTORE_DATABASE_URL to a scratch database.");
	assertScratchTarget(target);
	const keyText =
		process.env.BACKUP_ENCRYPTION_KEY?.trim() ||
		(existsSync(".secrets/backup-encryption-key")
			? (await readFile(".secrets/backup-encryption-key", "utf8")).trim()
			: undefined);
	const { name, sealed } = await sealedBackup();
	const dump = decryptBackup(sealed, backupKey(keyText), name);
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-restore-"));
	try {
		const dumpPath = join(directory, "restore.dump");
		await writeFile(dumpPath, dump, { mode: 0o600 });
		try {
			await run(
				"pg_restore",
				[
					"--no-owner",
					"--no-privileges",
					"--clean",
					"--if-exists",
					"--exit-on-error",
					`--dbname=${libpqEnvironment(target).PGDATABASE}`,
					dumpPath,
				],
				{
					env: { PATH: process.env.PATH ?? "", ...libpqEnvironment(target) },
					maxBuffer: 16 * 1024 * 1024,
				},
			);
		} catch (error) {
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			const password = new URL(target).password;
			throw new Error(
				`pg_restore failed: ${(password ? stderr.replaceAll(password, "***") : stderr).slice(0, 2000)}`,
			);
		}
		const client = new pg.Client({ connectionString: target });
		await client.connect();
		try {
			const counts = await client.query<{ table: string; rows: string }>(
				`select 'auth_user' as table, count(*)::text as rows from public.auth_user
				 union all select 'project', count(*)::text from public.project
				 union all select 'agent_session', count(*)::text from public.agent_session
				 union all select 'migrations', count(*)::text from supabase_migrations.schema_migrations`,
			);
			console.log(
				JSON.stringify(
					Object.fromEntries(
						counts.rows.map((row) => [row.table, Number(row.rows)]),
					),
				),
			);
		} finally {
			await client.end();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Restore failed.");
	process.exit(1);
});

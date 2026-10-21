import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { backupR2Configuration } from "../scripts/backup-production-db";
import {
	assertProductionSource,
	assertScratchTarget,
	backupKey,
	backupObjectKey,
	decryptBackup,
	encryptBackup,
	latestBackupKey,
	libpqEnvironment,
} from "../scripts/db-backup-format";

const key = randomBytes(32);
const objectKey = backupObjectKey(new Date("2026-10-19T09:17:03.512Z"));

it("names backups by date so the newest sorts last", () => {
	expect(objectKey).toBe(
		"postgres/2026/10/19/ytimesy-production-2026-10-19T09-17-03Z.dump.enc",
	);
	expect(
		latestBackupKey([
			backupObjectKey(new Date("2026-10-18T09:17:00Z")),
			objectKey,
			"postgres/notes.txt",
			backupObjectKey(new Date("2026-09-30T09:17:00Z")),
		]),
	).toBe(objectKey);
	expect(latestBackupKey([])).toBeNull();
});

it("round-trips an encrypted dump and rejects tampering, wrong keys and renames", () => {
	const dump = Buffer.from("PGDMP fake custom-format dump");
	const sealed = encryptBackup(dump, key, objectKey);
	expect(sealed.includes(dump)).toBe(false);
	expect(decryptBackup(sealed, key, objectKey)).toEqual(dump);
	// A local copy keeps its file name and still decrypts.
	expect(
		decryptBackup(sealed, key, objectKey.slice(objectKey.lastIndexOf("/") + 1)),
	).toEqual(dump);
	const flipped = Buffer.from(sealed);
	flipped[flipped.length - 20] ^= 1;
	expect(() => decryptBackup(flipped, key, objectKey)).toThrow();
	expect(() => decryptBackup(sealed, randomBytes(32), objectKey)).toThrow();
	expect(() =>
		decryptBackup(sealed, key, "ytimesy-production-other.dump.enc"),
	).toThrow();
	expect(() => decryptBackup(Buffer.from("plain"), key, objectKey)).toThrow(
		/Not a ytimesy database backup/,
	);
});

it("accepts a 32-byte key as hex or base64 only", () => {
	expect(backupKey(key.toString("hex"))).toEqual(key);
	expect(backupKey(key.toString("base64"))).toEqual(key);
	expect(() => backupKey(undefined)).toThrow(/BACKUP_ENCRYPTION_KEY/);
	expect(() => backupKey(randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
});

it("passes the connection to pg_dump through libpq variables, not argv", () => {
	expect(
		libpqEnvironment(
			"postgresql://postgres.exampleprojectref:p%40ss@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=verify-full",
			".secrets/supabase-ca.crt",
		),
	).toEqual({
		PGHOST: "aws-0-us-east-2.pooler.supabase.com",
		PGPORT: "5432",
		PGUSER: "postgres.exampleprojectref",
		PGPASSWORD: "p@ss",
		PGDATABASE: "postgres",
		PGSSLMODE: "verify-full",
		PGSSLROOTCERT: ".secrets/supabase-ca.crt",
		PGCONNECT_TIMEOUT: "20",
	});
});

it("backs up only production and restores only into a scratch database", () => {
	expect(() =>
		assertProductionSource(
			"postgresql://postgres.exampleprojectref:x@pooler.example:5432/postgres",
		),
	).not.toThrow();
	expect(() =>
		assertProductionSource(
			"postgresql://postgres.exampledevprojectref:x@pooler.example:5432/postgres",
		),
	).toThrow(/not the production database/);
	expect(() =>
		assertScratchTarget(
			"postgresql://postgres.exampleprojectref:x@pooler.example:5432/postgres",
		),
	).toThrow(/production/);
	expect(() =>
		assertScratchTarget(
			"postgresql://postgres.exampledevprojectref:x@pooler.example:5432/postgres",
		),
	).toThrow(/development/);
	expect(() =>
		assertScratchTarget("postgresql://postgres:x@localhost:5432/restore_drill"),
	).not.toThrow();
});

it("requires a dedicated, well-formed backup bucket", () => {
	const env = {
		R2_ACCOUNT_ID: "a".repeat(32),
		R2_ACCESS_KEY_ID: "id",
		R2_SECRET_ACCESS_KEY: "secret",
		R2_BACKUP_BUCKET: "ytimesy-db-backups",
	};
	expect(backupR2Configuration(env).bucket).toBe("ytimesy-db-backups");
	expect(() =>
		backupR2Configuration({ ...env, R2_BACKUP_BUCKET: undefined }),
	).toThrow(/R2_BACKUP_BUCKET/);
});

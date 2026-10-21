/**
 * The pieces of the production database backup that need no network or
 * database: the encrypted file format, object naming, pg_dump's environment
 * and the guards that keep a restore away from real databases.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const PRODUCTION_DATABASE_REF = "vpxypoluphsggiqbfhse";
export const DEVELOPMENT_DATABASE_REF = "zqkptvyvoyqqtpihlshw";
export const BACKUP_PREFIX = "postgres/";
/** Schemas the app owns: its tables (public) and its migration record. */
export const BACKUP_SCHEMAS = ["public", "supabase_migrations"] as const;

const MAGIC = Buffer.from("YTBK1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 32-byte AES key given as 64 hex characters or base64. */
export function backupKey(value: string | undefined): Buffer {
	const text = value?.trim();
	if (!text)
		throw new Error("Set BACKUP_ENCRYPTION_KEY (32 bytes, hex or base64).");
	const key = Buffer.from(
		text,
		/^[a-f0-9]{64}$/i.test(text) ? "hex" : "base64",
	);
	if (key.length !== 32)
		throw new Error("BACKUP_ENCRYPTION_KEY must decode to 32 bytes.");
	return key;
}

/** AES-256-GCM: magic, IV, ciphertext, tag. The object name is authenticated too. */
export function encryptBackup(plain: Buffer, key: Buffer, objectKey: string) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(objectName(objectKey)));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decryptBackup(sealed: Buffer, key: Buffer, objectKey: string) {
	if (
		sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
		!sealed.subarray(0, MAGIC.length).equals(MAGIC)
	)
		throw new Error("Not a ytimesy database backup.");
	const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
	const tag = sealed.subarray(sealed.length - TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(Buffer.from(objectName(objectKey)));
	decipher.setAuthTag(tag);
	return Buffer.concat([
		decipher.update(
			sealed.subarray(MAGIC.length + IV_BYTES, sealed.length - TAG_BYTES),
		),
		decipher.final(),
	]);
}

/** The file name alone, so a downloaded copy decrypts under the same name. */
function objectName(objectKey: string) {
	return objectKey.slice(objectKey.lastIndexOf("/") + 1);
}

/** postgres/2026/10/19/ytimesy-production-2026-10-19T03-00-00Z.dump.enc */
export function backupObjectKey(now = new Date()) {
	const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
	const [day] = iso.split("T");
	return `${BACKUP_PREFIX}${day.replaceAll("-", "/")}/ytimesy-production-${iso.replaceAll(":", "-")}.dump.enc`;
}

/** The newest backup among listed keys (names sort by time). */
export function latestBackupKey(keys: readonly string[]) {
	return (
		keys
			.filter(
				(key) => key.startsWith(BACKUP_PREFIX) && key.endsWith(".dump.enc"),
			)
			.sort()
			.at(-1) ?? null
	);
}

/**
 * libpq environment for pg_dump/pg_restore, so the password never appears in
 * a command line (visible to other processes) or in logs.
 */
export function libpqEnvironment(
	databaseUrl: string,
	caPath?: string,
): Record<string, string> {
	const url = new URL(databaseUrl);
	if (!["postgres:", "postgresql:"].includes(url.protocol))
		throw new Error("The database URL must be a postgres:// URL.");
	const sslmode = url.searchParams.get("sslmode");
	const rootcert = url.searchParams.get("sslrootcert") ?? caPath;
	return {
		PGHOST: url.hostname,
		PGPORT: url.port || "5432",
		PGUSER: decodeURIComponent(url.username),
		PGPASSWORD: decodeURIComponent(url.password),
		PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || "postgres",
		...(sslmode ? { PGSSLMODE: sslmode } : {}),
		...(rootcert ? { PGSSLROOTCERT: rootcert } : {}),
		PGCONNECT_TIMEOUT: "20",
	};
}

/** The backup reads production and nothing else. */
export function assertProductionSource(databaseUrl: string) {
	const url = new URL(databaseUrl);
	if (
		!decodeURIComponent(url.username).includes(PRODUCTION_DATABASE_REF) &&
		!url.hostname.includes(PRODUCTION_DATABASE_REF)
	)
		throw new Error("The backup source is not the production database.");
}

/** A restore only ever targets a scratch database: never production or development. */
export function assertScratchTarget(databaseUrl: string) {
	const text = decodeURIComponent(databaseUrl);
	if (text.includes(PRODUCTION_DATABASE_REF))
		throw new Error("Refusing to restore into the production database.");
	if (text.includes(DEVELOPMENT_DATABASE_REF))
		throw new Error("Refusing to restore into the development database.");
}

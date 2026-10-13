import { readFile } from "node:fs/promises";
import {
	type ClaudeHomeFiles,
	claudeHomeFilesAreUsable,
	parseClaudeHomeDump,
} from "#/domain/claude-home";
import {
	decryptSecret,
	type EncryptedSecret,
	encryptSecret,
} from "#/domain/encrypted-secret";
import { database } from "../adapters/database";
import { loadSecretMasterKey } from "./master-key";

/** Where development kept these before they moved to Postgres; read once to import. */
const LEGACY_STORE_PATH = ".ytimesy/claude-homes.json";

export async function saveClaudeHomeForUser(
	userId: string,
	home: ClaudeHomeFiles,
): Promise<void> {
	if (!userId.trim() || !claudeHomeFilesAreUsable(home.files)) return;
	const masterKey = await loadSecretMasterKey();
	await database().query(
		`insert into claude_home(user_id,encrypted,updated_at) values($1,$2,now())
		 on conflict(user_id) do update set encrypted=excluded.encrypted,updated_at=now()`,
		[
			userId,
			JSON.stringify(
				encryptSecret(masterKey, JSON.stringify({ files: home.files })),
			),
		],
	);
}

export async function loadClaudeHomeForUser(
	userId: string,
): Promise<ClaudeHomeFiles | null> {
	if (!userId.trim()) return null;
	const stored = (
		await database().query<{ encrypted: unknown }>(
			"select encrypted from claude_home where user_id=$1",
			[userId],
		)
	).rows[0]?.encrypted;
	const encrypted = isEncrypted(stored) ? stored : await importLegacy(userId);
	if (!encrypted) return null;
	return parseClaudeHomeDump(
		decryptSecret(await loadSecretMasterKey(), encrypted),
	);
}

/** Development only: carries a login over from the old local file. */
async function importLegacy(userId: string) {
	if (process.env.YTIMESY_ENVIRONMENT === "production") return null;
	let records: unknown;
	try {
		records = JSON.parse(await readFile(LEGACY_STORE_PATH, "utf8"));
	} catch {
		return null;
	}
	const record = Array.isArray(records)
		? (records as { userId?: unknown; encrypted?: unknown }[]).find(
				(entry) => entry.userId === userId,
			)
		: undefined;
	if (!record || !isEncrypted(record.encrypted)) return null;
	await database().query(
		"insert into claude_home(user_id,encrypted) values($1,$2) on conflict(user_id) do nothing",
		[userId, JSON.stringify(record.encrypted)],
	);
	return record.encrypted;
}

function isEncrypted(value: unknown): value is EncryptedSecret {
	if (typeof value !== "object" || value === null) return false;
	const secret = value as Partial<EncryptedSecret>;
	return (
		secret.version === 1 &&
		typeof secret.iv === "string" &&
		typeof secret.tag === "string" &&
		typeof secret.ciphertext === "string"
	);
}

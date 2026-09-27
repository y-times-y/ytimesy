import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { loadSecretMasterKey } from "./master-key";

export const CLAUDE_HOME_STORE_PATH = ".ytimesy/claude-homes.json";

type StoredClaudeHome = {
	readonly userId: string;
	readonly encrypted: EncryptedSecret;
	readonly updatedAt: string;
};

export async function saveClaudeHomeForUser(
	userId: string,
	home: ClaudeHomeFiles,
): Promise<void> {
	if (!userId.trim() || !claudeHomeFilesAreUsable(home.files)) return;
	const masterKey = await loadSecretMasterKey();
	const record: StoredClaudeHome = {
		userId,
		encrypted: encryptSecret(masterKey, JSON.stringify({ files: home.files })),
		updatedAt: new Date().toISOString(),
	};
	const records = (await readRecords()).filter(
		(entry) => entry.userId !== userId,
	);
	records.push(record);
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(CLAUDE_HOME_STORE_PATH, `${JSON.stringify(records)}\n`, {
		mode: 0o600,
	});
}

export async function loadClaudeHomeForUser(
	userId: string,
): Promise<ClaudeHomeFiles | null> {
	if (!userId.trim()) return null;
	const record = (await readRecords()).find((entry) => entry.userId === userId);
	if (!record) return null;
	const masterKey = await loadSecretMasterKey();
	return parseClaudeHomeDump(decryptSecret(masterKey, record.encrypted));
}

async function readRecords(): Promise<StoredClaudeHome[]> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(CLAUDE_HOME_STORE_PATH, "utf8"),
		);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isRecord);
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is StoredClaudeHome {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<StoredClaudeHome>;
	return (
		typeof entry.userId === "string" &&
		typeof entry.updatedAt === "string" &&
		isEncrypted(entry.encrypted)
	);
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AgentProviderId } from "#/domain/agent-provider";
import { offeredAgentProviders } from "#/domain/agent-provider";
import {
	decryptSecret,
	type EncryptedSecret,
	encryptSecret,
	secretHint,
} from "#/domain/encrypted-secret";
import type { HarnessApiKeyRecord } from "#/domain/harness-api-key";
import { loadSecretMasterKey } from "./master-key";

export const HARNESS_KEY_STORE_PATH = ".ytimesy/harness-keys.json";

export async function saveHarnessApiKey(
	harnessId: AgentProviderId,
	plaintext: string,
): Promise<HarnessApiKeyRecord> {
	const secret = plaintext.trim();
	if (secret.length < 8) {
		throw new Error("API key is too short");
	}
	const masterKey = await loadSecretMasterKey();
	const record: HarnessApiKeyRecord = {
		harnessId,
		hint: secretHint(secret),
		encrypted: encryptSecret(masterKey, secret),
		updatedAt: new Date().toISOString(),
	};
	const records = await readRecords();
	const next = [
		...records.filter((entry) => entry.harnessId !== harnessId),
		record,
	];
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(HARNESS_KEY_STORE_PATH, `${JSON.stringify(next, null, 2)}\n`, {
		mode: 0o600,
	});
	return record;
}

export async function listHarnessApiKeys(): Promise<
	readonly HarnessApiKeyRecord[]
> {
	return readRecords();
}

export async function decryptHarnessApiKey(
	harnessId: AgentProviderId,
): Promise<string | null> {
	const record = (await readRecords()).find(
		(entry) => entry.harnessId === harnessId,
	);
	if (!record) return null;
	const masterKey = await loadSecretMasterKey();
	return decryptSecret(masterKey, record.encrypted);
}

export function parseHarnessId(value: string): AgentProviderId {
	const match = offeredAgentProviders().find((harness) => harness.id === value);
	if (!match) throw new Error("Unknown harness");
	return match.id;
}

async function readRecords(): Promise<HarnessApiKeyRecord[]> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(HARNESS_KEY_STORE_PATH, "utf8"),
		);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isRecord);
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is HarnessApiKeyRecord {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<HarnessApiKeyRecord>;
	return (
		typeof entry.harnessId === "string" &&
		typeof entry.hint === "string" &&
		isEncrypted(entry.encrypted) &&
		typeof entry.updatedAt === "string"
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

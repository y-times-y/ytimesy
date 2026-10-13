import type { AgentProviderId } from "#/domain/agent-provider";
import { secretHint } from "#/domain/encrypted-secret";
import type { PublicHarnessApiKey } from "#/domain/harness-api-key";
import { database } from "../adapters/database";
import { seal, unseal } from "../auth/token-vault";

export async function saveHarnessApiKey(
	userId: string,
	harnessId: AgentProviderId,
	plaintext: string,
): Promise<void> {
	const secret = plaintext.trim();
	if (secret.length < 8) throw new Error("API key is too short");
	const encrypted = await seal(secret);
	await database().query(
		"insert into user_harness_api_key(user_id,provider,encrypted_key,hint) values($1,$2,$3,$4) on conflict(user_id,provider) do update set encrypted_key=excluded.encrypted_key,hint=excluded.hint,updated_at=now()",
		[userId, parseHarnessId(harnessId), encrypted, secretHint(secret)],
	);
}

export async function listHarnessApiKeys(
	userId: string,
): Promise<readonly PublicHarnessApiKey[]> {
	const result = await database().query(
		"select provider,hint from user_harness_api_key where user_id=$1",
		[userId],
	);
	return result.rows.map((row) => ({
		harnessId: parseHarnessId(row.provider),
		hint: row.hint,
	}));
}

export async function decryptHarnessApiKey(
	userId: string,
	harnessId: AgentProviderId,
): Promise<string | null> {
	const result = await database().query(
		"select encrypted_key from user_harness_api_key where user_id=$1 and provider=$2",
		[userId, parseHarnessId(harnessId)],
	);
	return result.rows[0] ? unseal(result.rows[0].encrypted_key) : null;
}

export function parseHarnessId(value: string): "codex" | "claude" {
	if (value !== "codex" && value !== "claude")
		throw new Error("Unsupported provider");
	return value;
}

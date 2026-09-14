import type { AgentProviderId } from "./agent-provider";
import type { EncryptedSecret } from "./encrypted-secret";

export type HarnessApiKeyRecord = {
	readonly harnessId: AgentProviderId;
	readonly hint: string;
	readonly encrypted: EncryptedSecret;
	readonly updatedAt: string;
};

export type PublicHarnessApiKey = {
	readonly harnessId: AgentProviderId;
	readonly hint: string;
};

export type HarnessApiKeyStatus = {
	readonly keys: readonly PublicHarnessApiKey[];
};

export function publicHarnessApiKey(
	record: HarnessApiKeyRecord,
): PublicHarnessApiKey {
	return { harnessId: record.harnessId, hint: record.hint };
}

export function hintForHarness(
	keys: readonly PublicHarnessApiKey[],
	harnessId: AgentProviderId,
): string | null {
	return keys.find((key) => key.harnessId === harnessId)?.hint ?? null;
}

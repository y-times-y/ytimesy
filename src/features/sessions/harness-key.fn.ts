import { createServerFn } from "@tanstack/react-start";
import {
	hintForHarness,
	type HarnessApiKeyStatus,
	publicHarnessApiKey,
} from "#/domain/harness-api-key";
import {
	listHarnessApiKeys,
	parseHarnessId,
	saveHarnessApiKey,
} from "#/server/secrets/harness-key-store";

export const getHarnessApiKeys = createServerFn({ method: "GET" }).handler(
	async (): Promise<HarnessApiKeyStatus> => {
		const keys = await listHarnessApiKeys();
		return { keys: keys.map(publicHarnessApiKey) };
	},
);

export const saveHarnessApiKeyFn = createServerFn({ method: "POST" })
	.validator((data: { harnessId: string; apiKey: string }) => {
		return {
			harnessId: parseHarnessId(data.harnessId),
			apiKey: data.apiKey,
		};
	})
	.handler(async ({ data }): Promise<HarnessApiKeyStatus> => {
		await saveHarnessApiKey(data.harnessId, data.apiKey);
		const keys = await listHarnessApiKeys();
		return { keys: keys.map(publicHarnessApiKey) };
	});

export function harnessKeyHintMap(
	status: HarnessApiKeyStatus,
): Partial<Record<ReturnType<typeof parseHarnessId>, string>> {
	return {
		codex: hintForHarness(status.keys, "codex") ?? undefined,
		claude: hintForHarness(status.keys, "claude") ?? undefined,
		opencode: hintForHarness(status.keys, "opencode") ?? undefined,
	};
}

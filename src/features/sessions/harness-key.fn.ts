import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
	type HarnessApiKeyStatus,
	hintForHarness,
} from "#/domain/harness-api-key";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	listHarnessApiKeys,
	parseHarnessId,
	saveHarnessApiKey,
} from "#/server/secrets/harness-key-store";

export const getHarnessApiKeys = createServerFn({ method: "GET" }).handler(
	async (): Promise<HarnessApiKeyStatus> => {
		const user = await requireUser(getRequest().headers);
		const keys = await listHarnessApiKeys(user.id);
		return { keys };
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
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await saveHarnessApiKey(user.id, data.harnessId, data.apiKey);
		const keys = await listHarnessApiKeys(user.id);
		return { keys };
	});

export function harnessKeyHintMap(
	status: HarnessApiKeyStatus,
): Partial<Record<ReturnType<typeof parseHarnessId>, string>> {
	return {
		codex: hintForHarness(status.keys, "codex") ?? undefined,
		claude: hintForHarness(status.keys, "claude") ?? undefined,
	};
}

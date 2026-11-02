import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	CLAUDE_CODE_KEY,
	CLAUDE_CODE_LABEL,
	claudeSubscriptionEnabled,
} from "#/domain/claude-code-route";
import {
	type FailoverConnectionKind,
	failoverConnectionKind,
	orderedFailoverConnections,
	SUBSCRIPTION_KEY,
} from "#/domain/model-failover";
import { hasClaudeSubscription } from "#/server/adapters/claude-subscription";
import { listModelConnections } from "#/server/adapters/model-connections";
import {
	connectionOrderSchema,
	loadModelFailoverPreferences,
	type ModelFailoverPreferences,
	saveModelFailoverPreferences,
} from "#/server/adapters/model-failover-preferences";
import { requireUser } from "#/server/auth/auth";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { requireSameOrigin } from "#/server/http";
import { SUBSCRIPTION_LABEL } from "#/server/services/model-failover";

export type ModelFailoverSettings = {
	readonly enabled: boolean;
	readonly askBeforePaid: boolean;
	/** The user's connections in failover order, best first. */
	readonly connections: readonly {
		readonly key: string;
		readonly label: string;
		readonly kind: FailoverConnectionKind;
	}[];
};

async function readSettings(userId: string): Promise<ModelFailoverSettings> {
	const [preferences, codex, claude, connections] = await Promise.all([
		loadModelFailoverPreferences(userId),
		hasManagedCodexAuth(userId).catch(() => false),
		claudeSubscriptionEnabled()
			? hasClaudeSubscription(userId).catch(() => false)
			: false,
		listModelConnections(userId),
	]);
	return settingsView(preferences, [
		...(codex
			? [
					{
						key: SUBSCRIPTION_KEY,
						label: SUBSCRIPTION_LABEL,
						kind: "subscription" as const,
					},
				]
			: []),
		...(claude
			? [
					{
						key: CLAUDE_CODE_KEY,
						label: CLAUDE_CODE_LABEL,
						kind: "subscription" as const,
					},
				]
			: []),
		...connections.map((connection) => ({
			key: connection.id,
			label: connection.label,
			kind: failoverConnectionKind(connection),
		})),
	]);
}

function settingsView(
	preferences: ModelFailoverPreferences,
	connections: ModelFailoverSettings["connections"],
): ModelFailoverSettings {
	return {
		enabled: preferences.enabled,
		askBeforePaid: preferences.askBeforePaid,
		connections: orderedFailoverConnections(
			connections,
			preferences.connectionOrder,
		),
	};
}

export const getModelFailoverSettings = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await requireUser(getRequest().headers);
	return readSettings(user.id);
});

export const saveModelFailoverSettingsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				enabled: z.boolean(),
				askBeforePaid: z.boolean(),
				connectionOrder: connectionOrderSchema,
			})
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await saveModelFailoverPreferences(user.id, data);
		return readSettings(user.id);
	});

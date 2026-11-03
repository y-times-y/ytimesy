import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	claudeCodeListedModels,
	claudeSubscriptionEnabled,
} from "#/domain/claude-code-route";
import {
	claudeSubscriptionStatus,
	disconnectClaudeSubscription,
	saveClaudeSubscriptionToken,
} from "#/server/adapters/claude-subscription";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

/** What the browser sees: never the token, only its state. */
export type ClaudeSubscriptionView =
	| { readonly enabled: false }
	| {
			readonly enabled: true;
			readonly status: "disconnected" | "connected" | "refused" | "limited";
			readonly limitedUntil: number | null;
			readonly models: readonly {
				readonly id: string;
				readonly label: string;
			}[];
	  };

async function readView(userId: string): Promise<ClaudeSubscriptionView> {
	if (!claudeSubscriptionEnabled()) return { enabled: false };
	const status = await claudeSubscriptionStatus(userId);
	const usable = status.status === "connected" || status.status === "limited";
	return {
		enabled: true,
		status: status.status,
		limitedUntil: status.status === "disconnected" ? null : status.limitedUntil,
		models: usable
			? claudeCodeListedModels().map(({ id, label }) => ({ id, label }))
			: [],
	};
}

export const getClaudeSubscription = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return readView(user.id);
	},
);

export const saveClaudeSubscriptionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ token: z.string().min(1).max(1000) })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		if (!claudeSubscriptionEnabled())
			throw new Error("Claude Agent is not available.");
		await saveClaudeSubscriptionToken(user.id, data.token);
		return readView(user.id);
	});

export const disconnectClaudeSubscriptionFn = createServerFn({
	method: "POST",
})
	// An empty object, so the call has the JSON body requireSameOrigin needs.
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await disconnectClaudeSubscription(user.id);
		return readView(user.id);
	});

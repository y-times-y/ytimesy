import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { PushCardState } from "#/domain/push-approval";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	cancelPushApproval,
	pushApprovalCardStatus,
	pushApprovedChange,
} from "#/server/services/push-approval";

const cardInput = (data: unknown) =>
	z
		.object({
			sessionId: z.uuid(),
			itemId: z.string().min(1).max(300),
		})
		.strict()
		.parse(data);

async function cardUser() {
	const request = getRequest();
	requireSameOrigin(request);
	return requireUser(request.headers);
}

async function wakeChat(
	userId: string,
	card: { sessionId: string; itemId: string },
	detail: string,
) {
	const [{ Effect }, { FreestyleWorkspaceMachinesLive }, capabilities, wake] =
		await Promise.all([
			import("effect"),
			import("#/server/adapters/freestyle/live"),
			import("#/server/services/capabilities"),
			import("#/server/services/push-approval-wake"),
		]);
	const machines = await Effect.runPromise(
		Effect.provide(
			capabilities.WorkspaceMachineService,
			FreestyleWorkspaceMachinesLive,
		),
	);
	await wake.wakeChatAfterPush(machines, {
		userId,
		sessionId: card.sessionId,
		cardId: card.itemId,
		detail,
	});
}

/** A push card's state when shown: pending, or its answer (expired and outdated cards are settled here). */
export const pushApprovalStatusFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		return pushApprovalCardStatus({ userId: user.id, ...data });
	});

/** Push: the server pushes the approved commit, then tells the chat so its agent carries on. */
export const pushApprovedChangeFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		const state = await pushApprovedChange({ userId: user.id, ...data });
		if (state.answer === "pushed")
			// Bookkeeping: a chat that cannot be woken never fails the push.
			await wakeChat(user.id, data, state.detail).catch((error: unknown) =>
				console.warn("The chat was not woken after its push.", {
					error: error instanceof Error ? error.message : "unknown",
				}),
			);
		return state;
	});

/** Cancel: nothing is pushed and no turn starts. */
export const cancelPushApprovalFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		return cancelPushApproval({ userId: user.id, ...data });
	});

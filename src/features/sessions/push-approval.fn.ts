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

/** A push card's state when shown: pending, or its answer (expired and outdated cards are settled here). */
export const pushApprovalStatusFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		return pushApprovalCardStatus({ userId: user.id, ...data });
	});

/** Push: the server pushes the approved commit; no turn starts. */
export const pushApprovedChangeFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		return pushApprovedChange({ userId: user.id, ...data });
	});

/** Cancel: nothing is pushed and no turn starts. */
export const cancelPushApprovalFn = createServerFn({ method: "POST" })
	.validator(cardInput)
	.handler(async ({ data }): Promise<PushCardState> => {
		const user = await cardUser();
		return cancelPushApproval({ userId: user.id, ...data });
	});

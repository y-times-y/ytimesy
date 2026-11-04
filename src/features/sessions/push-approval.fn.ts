import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { approveChatPushRequest } from "#/server/services/push-approval";

export const approvePushRequestFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				sessionId: z.uuid(),
				itemId: z.string().min(1).max(300),
			})
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await approveChatPushRequest({ userId: user.id, ...data });
	});

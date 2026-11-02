import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireUser } from "#/server/auth/auth";
import {
	advanceXaiDeviceLogin,
	startXaiDeviceLogin,
} from "#/server/auth/xai-device-login";
import { disconnectXaiSubscription } from "#/server/auth/xai-subscription";
import { requireSameOrigin } from "#/server/http";

/** Starts SuperGrok sign-in (Settings, first run); off with its feature switch. */
export const startXaiSignIn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return startXaiDeviceLogin(user.id);
	});

/** Advances a pending SuperGrok sign-in; the card polls this while it waits. */
export const pollXaiSignIn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return advanceXaiDeviceLogin(user.id);
	});

export const disconnectXaiSubscriptionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await disconnectXaiSubscription(user.id);
		return { status: "disconnected" as const };
	});

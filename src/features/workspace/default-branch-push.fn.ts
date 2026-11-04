import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	defaultBranchPushSetting,
	setDefaultBranchPushSetting,
} from "#/server/adapters/default-branch-push";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

const projectInput = z.object({ projectId: z.uuid() });

export const readDefaultBranchPushFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const allowed = await defaultBranchPushSetting(user.id, data.projectId);
		if (allowed === null)
			throw new Response("Project is not available.", { status: 404 });
		return { allowed };
	});

export const saveDefaultBranchPushFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ allowed: z.boolean() }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await setDefaultBranchPushSetting(user.id, data.projectId, data.allowed);
		return { allowed: data.allowed };
	});

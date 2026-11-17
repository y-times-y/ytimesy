import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { projectYMode, setProjectYMode } from "#/server/adapters/y-mode";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

const projectInput = z.object({ projectId: z.uuid() });

export const readYModeFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const mode = await projectYMode(user.id, data.projectId);
		if (!mode) throw new Response("Project is not available.", { status: 404 });
		return { enabled: mode.enabled };
	});

export const saveYModeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ enabled: z.boolean() }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await setProjectYMode(user.id, data.projectId, data.enabled);
		return { enabled: data.enabled };
	});

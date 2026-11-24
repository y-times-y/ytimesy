import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { parseSettingsPatch } from "#/domain/y-squared-proactive";
import { projectYMode, setProjectYMode } from "#/server/adapters/y-mode";
import { ySquaredCrewFor } from "#/server/adapters/y-squared-crew-client";
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

/** Y²'s proactivity for a Y project: settings, schedules, today's wake count (one crew request). Empty without a crew binding. */
async function proactiveCrew(projectId: string) {
	const user = await requireUser(getRequest().headers);
	const mode = await projectYMode(user.id, projectId);
	if (!mode?.enabled) throw new Response("Y is off.", { status: 404 });
	return ySquaredCrewFor(projectId);
}

export const readYProactiveFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) => {
		const crew = await proactiveCrew(data.projectId);
		return (await crew?.proactive?.()) ?? null;
	});

export const saveYProactiveFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput
			.extend({
				stallNudges: z.boolean().optional(),
				modelChoice: z.boolean().optional(),
				timezone: z.string().max(64).optional(),
			})
			.parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const crew = await proactiveCrew(data.projectId);
		const { projectId: _projectId, ...patch } = data;
		return (await crew?.saveSettings?.(parseSettingsPatch(patch))) ?? null;
	});

export const cancelYScheduleFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ id: z.string().min(1).max(64) }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const crew = await proactiveCrew(data.projectId);
		return { cancelled: (await crew?.cancelSchedule?.(data.id)) ?? false };
	});

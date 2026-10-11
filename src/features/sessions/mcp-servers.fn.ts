import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	addMcpServer,
	listMcpServers,
	mcpServerInput,
	removeMcpServer,
	setMcpServerEnabled,
} from "#/server/adapters/mcp-servers";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { connectMcpTools } from "#/server/services/mcp-tools";

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return listMcpServers(user.id);
	},
);

/** Connects once before saving, so a wrong URL or credential fails here, not mid-run. */
export const addMcpServerFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		mcpServerInput
			.pick({ name: true, url: true, headers: true, projectId: true })
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		const probe = await connectMcpTools([
			{ name: data.name, url: data.url, headers: data.headers ?? {} },
		]);
		const toolCount = Object.keys(probe.tools).length;
		await probe.close();
		if (probe.unavailable.length)
			throw new Error(
				"Could not connect to that MCP server. Check the HTTPS URL and its credentials.",
			);
		await addMcpServer(user.id, data);
		return { servers: await listMcpServers(user.id), toolCount };
	});

export const setMcpServerEnabledFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ id: z.string().uuid(), enabled: z.boolean() })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await setMcpServerEnabled(user.id, data.id, data.enabled);
		return listMcpServers(user.id);
	});

export const removeMcpServerFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ id: z.string().uuid() }).strict().parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await removeMcpServer(user.id, data.id);
		return listMcpServers(user.id);
	});

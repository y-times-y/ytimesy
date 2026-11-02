import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { mcpTokenHeaders } from "#/domain/mcp-token";
import {
	addMcpServer,
	mcpServerForOwner,
	mcpServerInput,
	removeMcpServer,
	saveMcpServerToken,
	setMcpServerEnabled,
} from "#/server/adapters/mcp-servers";
import { requireUser } from "#/server/auth/auth";
import { serverConfig } from "#/server/config";
import { requireSameOrigin } from "#/server/http";
import { requiresOAuth, startMcpOAuth } from "#/server/services/mcp-oauth";
import {
	type McpSignInStart,
	mcpSignInStartFailure,
} from "#/server/services/mcp-oauth-client";
import { listMcpServersChecked } from "#/server/services/mcp-sign-in-status";
import { connectMcpTools } from "#/server/services/mcp-tools";

export const getMcpServersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return listMcpServersChecked(user.id);
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
		if (probe.unavailable.length) {
			// No credential given and the server asks for one: it signs users in with OAuth.
			if (
				!Object.keys(data.headers ?? {}).length &&
				(await requiresOAuth(data.url))
			) {
				const server = await addMcpServer(user.id, { ...data, auth: "oauth" });
				return {
					servers: await listMcpServersChecked(user.id),
					toolCount: 0,
					signIn: server.id,
				};
			}
			throw new Error(
				"Could not connect to that MCP server. Check the HTTPS URL and its credentials.",
			);
		}
		await addMcpServer(user.id, data);
		return {
			servers: await listMcpServersChecked(user.id),
			toolCount,
			signIn: null,
		};
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
		return listMcpServersChecked(user.id);
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
		return listMcpServersChecked(user.id);
	});

/** Returns the provider's sign-in URL, or null when the stored sign-in still works. */
export const startMcpOAuthFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ id: z.string().uuid() }).strict().parse(data),
	)
	.handler(async ({ data }): Promise<McpSignInStart> => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		try {
			const started: McpSignInStart = {
				url: await startMcpOAuth({
					userId: user.id,
					serverId: data.id,
					appUrl: serverConfig().APP_URL,
				}),
			};
			return started;
		} catch (error) {
			// Never the SDK's text: a short line, and a token field when that helps.
			console.warn("MCP sign-in did not start", {
				serverId: data.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return mcpSignInStartFailure(error);
		}
	});

/** The user's own token or API key for a server that cannot sign them in here. */
export const setMcpServerTokenFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ id: z.string().uuid(), token: z.string().min(1).max(4096) })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		const server = await mcpServerForOwner(user.id, data.id);
		if (!server) throw new Error("MCP server not found.");
		const headers = mcpTokenHeaders(data.token);
		const probe = await connectMcpTools([
			{ name: server.name, url: server.url, headers },
		]);
		await probe.close();
		if (probe.unavailable.length) throw new Error("That token didn't work.");
		await saveMcpServerToken(user.id, server.id, headers);
		return listMcpServersChecked(user.id);
	});

import { mcpToolName } from "#/domain/mcp-tool-call";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { turnOAuthProvider } from "../services/mcp-oauth";
import { connectMcpTools } from "../services/mcp-tools";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";
import { connectableMcpServers } from "./mcp-servers";

/**
 * MCP servers for a turn on a box (docs/turn-runner-boxes.md, "MCP on a
 * box"). Their URLs, headers and OAuth tokens stay on the edge: the box gets
 * the tool list (names, descriptions, input schemas) once per turn and sends
 * each call here, where the edge connects to that one server, calls the tool
 * and answers its (bounded) result. Only the turn's own user's servers for
 * the turn's own chat's project are reachable.
 */
export type TurnBoxMcpDeps = {
	readonly servers?: typeof connectableMcpServers;
	readonly connect?: typeof connectMcpTools;
	readonly appUrl?: string;
};

async function turnServers(turn: ApiTurn, deps: TurnBoxMcpDeps) {
	const owner = await agentSessionMetadataForOwner(
		turn.user_id,
		turn.session_id,
	);
	if (!owner) throw new TurnBoxPortForbidden("session");
	const servers = await (deps.servers ?? connectableMcpServers)(
		turn.user_id,
		owner.projectId ?? null,
	);
	const appUrl = deps.appUrl ?? process.env.APP_URL ?? "http://localhost:3000";
	return Promise.all(
		servers
			// OAuth servers join once the user has signed in.
			.filter((server) => server.auth !== "oauth" || server.sealedOAuth)
			.map(async (server) => ({
				key: `${server.id}:${server.url}`,
				name: server.name,
				url: server.url,
				headers: server.headers,
				authProvider:
					server.auth === "oauth"
						? await turnOAuthProvider({
								userId: turn.user_id,
								serverId: server.id,
								sealedOAuth: server.sealedOAuth,
								appUrl,
							})
						: undefined,
			})),
	);
}

/** The turn's MCP tools as data: no credential, no live connection. */
export async function mcpListingPort(
	turn: ApiTurn,
	deps: TurnBoxMcpDeps = {},
	signal?: AbortSignal,
) {
	const connected = await (deps.connect ?? connectMcpTools)(
		await turnServers(turn, deps),
		signal ? { signal } : {},
	);
	try {
		return {
			catalog: connected.catalog,
			purposes: connected.purposes,
			unavailable: connected.unavailable,
		};
	} finally {
		await connected.close();
	}
}

/** One tool call on one of the turn's servers, connected for this call only. */
export async function mcpCallPort(
	turn: ApiTurn,
	call: {
		readonly server: string;
		readonly tool: string;
		readonly input: unknown;
	},
	deps: TurnBoxMcpDeps = {},
	signal?: AbortSignal,
) {
	const server = (await turnServers(turn, deps)).find(
		(entry) => entry.name === call.server,
	);
	if (!server) throw new TurnBoxPortForbidden("mcp:server");
	const connected = await (deps.connect ?? connectMcpTools)(
		[server],
		signal ? { signal } : {},
	);
	try {
		if (connected.unavailable.length)
			throw new Error(`MCP server ${call.server} is unavailable.`);
		const execute =
			connected.tools[mcpToolName(call.server, call.tool)]?.execute;
		if (!execute)
			throw new Error(`MCP server ${call.server} does not offer ${call.tool}.`);
		return await execute(call.input as never, {
			toolCallId: "box",
			messages: [],
			context: {},
			...(signal ? { abortSignal: signal } : {}),
		});
	} finally {
		await connected.close();
	}
}

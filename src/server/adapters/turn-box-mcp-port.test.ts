import { describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./agent-sessions", () => ({
	agentSessionMetadataForOwner: async (_user: string, id: string) =>
		id === "s1" ? { id: "s1", projectId: "p1" } : null,
}));

import type { ApiTurn } from "./api-turns";
import { mcpCallPort, mcpListingPort } from "./turn-box-mcp-port";

const turn = { id: "t1", user_id: "u1", session_id: "s1" } as ApiTurn;
const servers = async () =>
	[
		{
			id: "m1",
			auth: "headers",
			sealedOAuth: null,
			name: "docs",
			url: "https://docs.test/mcp",
			headers: { authorization: "Bearer SECRET-TOKEN" },
		},
		{
			id: "m2",
			auth: "headers",
			sealedOAuth: null,
			name: "tracker",
			url: "https://tracker.test/mcp",
			headers: { authorization: "Bearer OTHER-SECRET" },
		},
	] as never;

function connector() {
	const connected: string[][] = [];
	const executed: unknown[] = [];
	const connect = (async (list: { name: string }[]) => {
		connected.push(list.map((server) => server.name));
		return {
			tools: Object.fromEntries(
				list.map((server) => [
					`mcp__${server.name}__search`,
					{
						execute: async (input: unknown) => {
							executed.push({ server: server.name, input });
							return { ok: server.name };
						},
					},
				]),
			),
			catalog: list.map((server) => ({
				name: `mcp__${server.name}__search`,
				server: server.name,
				tool: "search",
				description: "Search",
				inputSchema: { type: "object" },
			})),
			purposes: {},
			unavailable: [],
			close: async () => undefined,
		};
	}) as never;
	return { connect, connected, executed };
}

describe("MCP for a box: the edge keeps the credentials", () => {
	it("answers the tool list as data, without a header, URL or token", async () => {
		const c = connector();
		const listing = await mcpListingPort(turn, {
			servers,
			connect: c.connect,
		});
		const text = JSON.stringify(listing);
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("https://");
		expect(listing.catalog.map((entry) => entry.server)).toEqual([
			"docs",
			"tracker",
		]);
	});

	it("calls one tool on one of the turn's servers, connecting only that one", async () => {
		const c = connector();
		const result = await mcpCallPort(
			turn,
			{ server: "tracker", tool: "search", input: { q: 1 } },
			{ servers, connect: c.connect },
		);
		expect(result).toEqual({ ok: "tracker" });
		expect(c.connected).toEqual([["tracker"]]);
		expect(c.executed).toEqual([{ server: "tracker", input: { q: 1 } }]);
	});

	it("refuses a server the turn's user does not have", async () => {
		const c = connector();
		await expect(
			mcpCallPort(
				turn,
				{ server: "someone-elses", tool: "search", input: {} },
				{ servers, connect: c.connect },
			),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		expect(c.connected).toEqual([]);
	});
});

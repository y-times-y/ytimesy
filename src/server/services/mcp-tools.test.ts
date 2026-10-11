import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectMcpTools } from "./mcp-tools";

let server: Server;
let url: string;
const seenAuth: (string | undefined)[] = [];

// A minimal Streamable-HTTP MCP server: JSON-RPC over POST, bearer-protected.
beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			seenAuth.push(request.headers.authorization);
			if (request.headers.authorization !== "Bearer secret-token") {
				response.writeHead(401).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: {
					name?: string;
					arguments?: { text?: string };
					protocolVersion?: string;
				};
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const reply = (result: unknown) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
				);
			};
			if (message.method === "initialize")
				return reply({
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1.0.0" },
				});
			if (message.method === "tools/list")
				return reply({
					tools: [
						{
							name: "echo",
							description: "Echo text back",
							inputSchema: {
								type: "object",
								properties: { text: { type: "string" } },
								required: ["text"],
							},
						},
						{
							name: "huge.report",
							description: "Returns a lot",
							inputSchema: { type: "object", properties: {} },
						},
					],
				});
			if (message.method === "tools/call")
				return reply({
					content: [
						{
							type: "text",
							text:
								message.params?.name === "echo"
									? `echo: ${message.params.arguments?.text}`
									: "x".repeat(100_000),
						},
					],
				});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Method not found" },
				}),
			);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const options = {
	toolCallId: "call",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

it("offers a remote server's tools under prefixed names, sending its headers from our server", async () => {
	const connected = await connectMcpTools([
		{ name: "fixture", url, headers: { Authorization: "Bearer secret-token" } },
		{ name: "down", url: "http://127.0.0.1:1/mcp", headers: {} },
	]);
	try {
		expect(Object.keys(connected.tools).sort()).toEqual([
			"mcp__fixture__echo",
			"mcp__fixture__huge_report",
		]);
		expect(connected.unavailable).toEqual(["down"]);
		expect(connected.tools.mcp__fixture__echo.description).toContain(
			"[MCP fixture]",
		);
		const echoed = await connected.tools.mcp__fixture__echo.execute?.(
			{ text: "hello" },
			options,
		);
		expect(JSON.stringify(echoed)).toContain("echo: hello");
		const huge = (await connected.tools.mcp__fixture__huge_report.execute?.(
			{},
			options,
		)) as { truncated: boolean; preview: string };
		expect(huge.truncated).toBe(true);
		expect(huge.preview.length).toBe(32_000);
		expect(seenAuth.every((value) => value === "Bearer secret-token")).toBe(
			true,
		);
	} finally {
		await connected.close();
	}
});

it("skips a server that rejects its credentials instead of failing the turn", async () => {
	const connected = await connectMcpTools([
		{ name: "locked", url, headers: { Authorization: "Bearer wrong" } },
	]);
	expect(connected.tools).toEqual({});
	expect(connected.unavailable).toEqual(["locked"]);
	await connected.close();
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePublicHost } from "../src/server/adapters/public-host";
import {
	isPublicAddress,
	WEB_FETCH_TOOL,
	webFetch,
	webFetchTool,
} from "../src/server/services/web-fetch-tool";

let server: Server;
let base: string;
const headers: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		headers.push(request.headers);
		const path = request.url ?? "/";
		if (path === "/page") {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(
				"<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello <a href='https://example.com/x'>link</a></p><img src='a.png'></body></html>",
			);
		} else if (path === "/data.json") {
			response.setHeader("content-type", "application/json");
			response.end('{"a":1}');
		} else if (path === "/missing") {
			response.statusCode = 404;
			response.end("nope");
		} else if (path === "/slow") {
			setTimeout(() => response.end("late"), 2_000);
		} else if (path === "/long") {
			response.setHeader("content-type", "text/plain");
			response.end(
				Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"),
			);
		} else if (path === "/huge") {
			response.setHeader("content-type", "text/plain");
			response.end("x".repeat(6 * 1024 * 1024));
		} else if (path === "/image") {
			response.setHeader("content-type", "image/png");
			response.end("png");
		} else if (path === "/to-page") {
			response.statusCode = 302;
			response.setHeader("location", "/page");
			response.end();
		} else if (path === "/to-metadata") {
			response.statusCode = 302;
			response.setHeader("location", "http://169.254.169.254/latest/");
			response.end();
		} else response.end("?");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// The test server is on localhost: let it through by name only.
const checkHost = async (host: string) => host === "localhost";
const get = (
	path: string,
	extra: { offset?: number; timeoutMs?: number } = {},
) => webFetch({ url: `${base}${path}`, checkHost, ...extra });

describe("webFetch", () => {
	it("returns an HTML page as text without scripts, styles or images", async () => {
		const out = await get("/page");
		expect(out).toContain(
			`URL: ${base}/page\nStatus: 200\nContent-Type: text/html`,
		);
		expect(out).toContain("TITLE");
		expect(out).toContain("Hello link [https://example.com/x]");
		expect(out).not.toContain("alert");
		expect(out).not.toContain("color:red");
		expect(out).not.toContain("a.png");
	});

	it("passes JSON through and follows a redirect to its final URL", async () => {
		expect(await get("/data.json")).toMatch(
			/Content-Type: application\/json\n\n\{"a":1\}$/,
		);
		expect(await get("/to-page")).toContain(`URL: ${base}/page\nStatus: 200`);
	});

	it("sends no cookies or credentials, only a user agent and Accept", async () => {
		headers.length = 0;
		await get("/data.json");
		expect(Object.keys(headers[0]).sort()).toEqual(
			expect.arrayContaining(["accept", "user-agent", "host"]),
		);
		expect(headers[0].cookie).toBeUndefined();
		expect(headers[0].authorization).toBeUndefined();
	});

	it("cuts long pages at the lean limit and reads on from an offset", async () => {
		const first = await get("/long");
		expect(first).toContain("line 2000\n");
		expect(first).not.toContain("line 2001");
		expect(first).toContain(
			"[Page cut to lines 1-2000 of 2500; call web_fetch again with offset: 2001 for more.]",
		);
		const next = await get("/long", { offset: 2001 });
		expect(next).toContain("line 2001\n");
		expect(next).toContain("line 2500");
		expect(next).not.toContain("Page cut");
	});

	it("turns failures into errors the model can act on", async () => {
		await expect(get("/missing")).rejects.toThrow(/returned HTTP 404/);
		await expect(get("/slow", { timeoutMs: 200 })).rejects.toThrow(
			/did not answer within/,
		);
		await expect(get("/huge")).rejects.toThrow(/over the 5242880-byte limit/);
		await expect(get("/image")).rejects.toThrow(/image\/png, not a text page/);
		await expect(
			webFetch({ url: "file:///etc/passwd", checkHost }),
		).rejects.toThrow(/only http and https/);
		await expect(
			webFetch({ url: `http://user:pw@localhost/`, checkHost }),
		).rejects.toThrow(/credentials/);
		await expect(webFetch({ url: "not a url", checkHost })).rejects.toThrow(
			/is not a URL/,
		);
	});

	it("refuses private and metadata hosts, also behind a redirect", async () => {
		await expect(
			webFetch({ url: "http://127.0.0.1/", checkHost: async () => true }),
		).rejects.toThrow(/not a public host/);
		await expect(get("/to-metadata")).rejects.toThrow(
			/169\.254\.169\.254 is not a public host/,
		);
		await expect(
			webFetch({ url: "http://other.test/", checkHost }),
		).rejects.toThrow(/not a public host/);
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		for (const address of ["10.0.0.1", "192.168.1.1", "::1", "fd00::1"])
			expect(isPublicAddress(address)).toBe(false);
		expect(await nodePublicHost("localhost")).toBe(false);
	});

	it("is a tool with a fixed description and a url/offset input", async () => {
		const tools = webFetchTool({ checkHost });
		const fetchTool = tools[WEB_FETCH_TOOL] as unknown as {
			description: string;
			execute: (input: unknown, options: unknown) => Promise<string>;
		};
		expect(fetchTool.description).toBe(
			webFetchTool({ checkHost: async () => false })[WEB_FETCH_TOOL]
				.description,
		);
		expect(
			await fetchTool.execute(
				{ url: `${base}/data.json` },
				{ toolCallId: "t", messages: [] },
			),
		).toContain('{"a":1}');
	});
});

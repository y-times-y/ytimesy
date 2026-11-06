import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	mcpServerInBackoff,
	noteMcpServerFailure,
	noteMcpServerRecovered,
	resetMcpServerHealthForTests,
} from "./mcp-server-health";
import { connectMcpTools } from "./mcp-tools";

beforeEach(() => resetMcpServerHealthForTests());
afterEach(() => vi.restoreAllMocks());

it("logs a failure once, again when the reason changes, and hourly", () => {
	expect(noteMcpServerFailure("a", "timeout", 0)).toBe(true);
	expect(noteMcpServerFailure("a", "timeout", 1_000)).toBe(false);
	expect(noteMcpServerFailure("a", "timeout", 59 * 60_000)).toBe(false);
	expect(noteMcpServerFailure("a", "401", 59 * 60_000 + 1)).toBe(true);
	expect(noteMcpServerFailure("a", "401", 61 * 60_000)).toBe(false);
	expect(noteMcpServerFailure("a", "401", 119 * 60_000 + 1)).toBe(true);
});

it("backs off retries, doubling up to a cap, and forgets on recovery", () => {
	noteMcpServerFailure("a", "x", 0);
	expect(mcpServerInBackoff("a", 5_000)).toBe(true);
	expect(mcpServerInBackoff("a", 10_000)).toBe(false);
	noteMcpServerFailure("a", "x", 10_000);
	expect(mcpServerInBackoff("a", 29_000)).toBe(true);
	expect(mcpServerInBackoff("a", 30_000)).toBe(false);
	for (let i = 0; i < 10; i += 1) noteMcpServerFailure("a", "x", 100_000);
	expect(mcpServerInBackoff("a", 100_000 + 120_000)).toBe(false);
	expect(noteMcpServerRecovered("a")).toBe(true);
	expect(mcpServerInBackoff("a", 100_001)).toBe(false);
});

it("connectMcpTools warns once for a server that stays down but reports it every time", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const refusing = (async () => {
		throw new Error("connection refused");
	}) as unknown as typeof fetch;
	const server = { name: "gone", url: "https://down.example/mcp", headers: {} };
	const first = await connectMcpTools([server], { fetch: refusing });
	const second = await connectMcpTools([server], { fetch: refusing });
	expect(first.unavailable).toEqual(["gone"]);
	expect(second.unavailable).toEqual(["gone"]);
	expect(warn).toHaveBeenCalledTimes(1);
});

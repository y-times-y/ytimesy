import { expect, it } from "vitest";
import { mcpTokenHeaders } from "./mcp-token";

it("sends a pasted token as a bearer token unless it names its scheme or header", () => {
	expect(mcpTokenHeaders(" ghp_abc ")).toEqual({
		Authorization: "Bearer ghp_abc",
	});
	expect(mcpTokenHeaders("Bearer xoxp-1")).toEqual({
		Authorization: "Bearer xoxp-1",
	});
	expect(mcpTokenHeaders("Basic dXNlcjpwYXNz")).toEqual({
		Authorization: "Basic dXNlcjpwYXNz",
	});
	expect(mcpTokenHeaders("DD-API-KEY: abc123")).toEqual({
		"DD-API-KEY": "abc123",
	});
	expect(mcpTokenHeaders("   ")).toEqual({});
});

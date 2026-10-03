import { expect, it } from "vitest";
import { publicToolDetail, toolOutputText } from "./tool-detail";

it("redacts credentials while preserving inspectable tool evidence", () => {
	const detail = publicToolDetail({
		command: "pnpm test",
		api_key: "private",
		nested: { access_token: "private" },
		stdout: "Bearer private sk-1234567890123456",
	});
	expect(detail).toContain("pnpm test");
	expect(detail).not.toContain("private");
	expect(detail).not.toContain("sk-1234567890123456");
	expect(JSON.parse(detail).api_key).toBe("[redacted]");
	expect(publicToolDetail("API_KEY=private")).not.toContain("private");
});

it("bounds display output without hiding that it was truncated", () => {
	expect(publicToolDetail("x".repeat(20000)).length).toBeLessThan(16100);
	expect(publicToolDetail("x".repeat(20000))).toContain("truncated");
});

it("renders captured shell results as readable output, not escaped JSON", () => {
	expect(
		toolOutputText(
			JSON.stringify({
				type: "json",
				value: { stdout: "first\nsecond", stderr: "", exitCode: 0 },
			}),
		),
	).toBe("first\nsecond\nexit 0");
	expect(
		toolOutputText(JSON.stringify({ type: "text", value: "file contents" })),
	).toBe("file contents");
});

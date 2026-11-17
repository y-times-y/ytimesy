import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every promise on the agent tool's start path must keep its cause: an
 * `Effect.tryPromise(fn)` without `catch` reports only Effect's "unknown
 * error" text (docs/subagent-start.md lists what is still unmapped).
 */
describe("subagent start path", () => {
	it("startPreparedAgentTask maps every tryPromise with a catch", () => {
		const source = readFileSync(
			new URL("./harness-workspace-session.ts", import.meta.url),
			"utf8",
		);
		const start = source.slice(
			source.indexOf("export function startPreparedAgentTask"),
			source.indexOf("export function emptyHarnessSession"),
		);
		expect(start).toContain("Effect.tryPromise");
		expect(start).not.toMatch(/Effect\.tryPromise\(\s*\(\)/);
		expect(start.match(/catch:/g)?.length).toBe(
			start.match(/Effect\.tryPromise/g)?.length,
		);
	});
});

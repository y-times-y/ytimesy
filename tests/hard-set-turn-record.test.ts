import { describe, expect, it } from "vitest";
import {
	childTranscript,
	setupLogSummary,
} from "../scripts/hard-set/turn-record";
import type { AgentSessionRecord } from "../src/server/adapters/agent-sessions";

const LOG = [
	"Get:1 http://archive.ubuntu.com noble InRelease",
	"[setup +2s] docker ready",
	"container reader: ytimesy-reader uid 998",
	"[setup +36s] route self-test ok (routed:container:/app)",
	"[setup +36s] reader route self-test ok (routed:container:998:/app:read-only)",
	"[setup +36s] setup done",
	"",
].join("\n");

describe("hard-set record: setup log", () => {
	it("keeps the setup's own lines, self-tests included, without the noise", () => {
		expect(setupLogSummary(LOG, 0)).toBe(
			[
				"[setup +2s] docker ready",
				"[setup +36s] route self-test ok (routed:container:/app)",
				"[setup +36s] reader route self-test ok (routed:container:998:/app:read-only)",
				"[setup +36s] setup done",
			].join("\n"),
		);
	});

	it("adds the raw tail when setup failed, where a failed self-test prints", () => {
		const failed = `[setup +2s] docker ready\nreader route self-test failed: got '', expected 'routed:container:998:/app:read-only'\n`;
		const summary = setupLogSummary(failed, 1);
		expect(summary).toContain("[setup +2s] docker ready");
		expect(summary).toContain("--- exit 1, last output:");
		expect(summary).toContain("reader route self-test failed");
	});
});

describe("hard-set transcript: subagent sessions", () => {
	it("keeps a checker's role and its items (tool calls and outputs)", () => {
		const items = [
			{
				kind: "dynamicToolCall",
				tool: "bash",
				status: "failed",
				output: "Could not start or observe command.",
			},
		];
		const child = childTranscript({
			id: "child",
			parentSessionId: "root",
			agentRole: "checker",
			title: "Review round 1",
			taskState: "completed",
			taskPlacement: "shared",
			createdAt: "2026-10-20T00:06:30.000Z",
			items,
			briefing: "not kept",
		} as unknown as AgentSessionRecord);
		expect(child).toEqual({
			id: "child",
			parentSessionId: "root",
			agentRole: "checker",
			title: "Review round 1",
			taskState: "completed",
			taskPlacement: "shared",
			createdAt: "2026-10-20T00:06:30.000Z",
			items,
		});
	});
});

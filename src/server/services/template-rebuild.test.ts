import { describe, expect, it } from "vitest";
import { requestTemplateRebuild } from "./template-rebuild.ts";

const now = new Date("2026-11-27T20:00:00Z");
function deps(state: { running: boolean; lastStartedAt: Date | null }) {
	const calls = { enqueue: 0, report: [] as string[], alert: [] as string[] };
	return {
		calls,
		deps: {
			now: () => now,
			builds: async () => state,
			enqueue: async () => {
				calls.enqueue += 1;
			},
			report: async (event: { kind: string }) => {
				calls.report.push(event.kind);
			},
			alert: async (alert: { kind: string }) => {
				calls.alert.push(alert.kind);
				return "sent" as const;
			},
		},
	};
}
const input = { workspaceId: "w1", sessionId: "s1" };

describe("requestTemplateRebuild", () => {
	it("enqueues one build, logs the event and alerts the owner", async () => {
		const { calls, deps: d } = deps({ running: false, lastStartedAt: null });
		expect(await requestTemplateRebuild(input, d)).toBe("requested");
		expect(calls).toEqual({
			enqueue: 1,
			report: ["template-missing-rebuild"],
			alert: ["template-missing"],
		});
	});

	it("does nothing while a build runs or one started in the last 5 minutes", async () => {
		for (const state of [
			{ running: true, lastStartedAt: null },
			{ running: false, lastStartedAt: new Date(now.getTime() - 60_000) },
		]) {
			const { calls, deps: d } = deps(state);
			expect(await requestTemplateRebuild(input, d)).toBe("already-building");
			expect(calls.enqueue).toBe(0);
		}
	});

	it("requests again once the last build is old", async () => {
		const { calls, deps: d } = deps({
			running: false,
			lastStartedAt: new Date(now.getTime() - 10 * 60_000),
		});
		await requestTemplateRebuild(input, d);
		expect(calls.enqueue).toBe(1);
	});
});

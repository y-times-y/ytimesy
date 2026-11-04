import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	PUSH_APPROVAL_REQUESTED_NOTE,
	requestedPushApproval,
} from "#/domain/push-approval";
import * as tool from "./push-approval-tool";
import { countCommitsCommand, pushApprovalTools } from "./push-approval-tool";

const refused = {
	id: "00000000-0000-4000-8000-0000000000bb",
	owner: "Acme",
	name: "app",
	branch: "main",
	oldId: "a".repeat(40),
	newId: "b".repeat(40),
};

function call(
	input: { repo: string; branch: string; summary: string },
	latest = refused as typeof refused | null,
	commits: number | null = 3,
	requested = true,
) {
	const latestRefused = vi.fn(async () => latest);
	const markRequested = vi.fn(async () => requested);
	const countCommits = vi.fn(async () => commits);
	const tools = pushApprovalTools({
		userId: "alice",
		projectId: "00000000-0000-4000-8000-000000000001",
		sessionId: "00000000-0000-4000-8000-0000000000cc",
		requests: { latestRefused, markRequested },
		countCommits,
	});
	const execute = tools.request_push_approval.execute as (
		value: typeof input,
	) => Promise<unknown>;
	return { result: execute(input), latestRefused, markRequested, countCommits };
}

describe("request_push_approval", () => {
	it("shows the push the proxy refused, with its commit count, and lets the agent go on", async () => {
		const { result, latestRefused, markRequested, countCommits } = call({
			repo: "acme/app.git",
			branch: "main",
			summary: " Ship the billing fix ",
		});
		const output = await result;
		expect(latestRefused).toHaveBeenCalledWith({
			userId: "alice",
			projectId: "00000000-0000-4000-8000-000000000001",
			owner: "acme",
			name: "app",
			branch: "main",
		});
		expect(countCommits).toHaveBeenCalledWith(refused.oldId, refused.newId);
		expect(requestedPushApproval(output, false)).toEqual({
			requestId: refused.id,
			repo: "Acme/app",
			branch: "main",
			commits: 3,
			summary: "Ship the billing fix",
		});
		expect(markRequested).toHaveBeenCalledWith(
			"alice",
			refused.id,
			"00000000-0000-4000-8000-0000000000cc",
		);
		expect(output).toMatchObject({ note: PUSH_APPROVAL_REQUESTED_NOTE });
	});

	it("never ends the turn", () => {
		expect("PUSH_APPROVAL_END_TURN_TOOLS" in tool).toBe(false);
		const turn = readFileSync("src/server/jobs/api-turn.ts", "utf8");
		const ends = turn.slice(
			turn.indexOf("endTurnTools: ["),
			turn.indexOf("endTurnTools: [") + 200,
		);
		expect(ends).not.toMatch(/PUSH|push/i);
	});

	it("refuses a second card for a push already asked for", async () => {
		const output = await call(
			{ repo: "acme/app", branch: "main", summary: "x" },
			refused,
			3,
			false,
		).result;
		expect(requestedPushApproval(output, false)).toBeNull();
		expect(output).toMatchObject({ requested: false });
	});

	it("refuses without a refused push, so the agent pushes first", async () => {
		const output = await call(
			{ repo: "acme/app", branch: "main", summary: "x" },
			null,
		).result;
		expect(output).toMatchObject({
			requested: false,
			error: expect.stringContaining("Push first"),
		});
		expect(requestedPushApproval(output, false)).toBeNull();
		expect(
			await call({ repo: "not a repo", branch: "main", summary: "x" }).result,
		).toMatchObject({ requested: false });
	});

	it("counts a new branch's commits from the start", () => {
		expect(countCommitsCommand("0".repeat(40), "b".repeat(40))).toBe(
			`git rev-list --count ${"b".repeat(40)}`,
		);
		expect(countCommitsCommand("a".repeat(40), "b".repeat(40))).toBe(
			`git rev-list --count ${"a".repeat(40)}..${"b".repeat(40)}`,
		);
		expect(() => countCommitsCommand("a; rm -rf /", "b".repeat(40))).toThrow();
	});
});

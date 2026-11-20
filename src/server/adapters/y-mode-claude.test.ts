import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./database", () => ({
	database: () => ({
		query: async () => ({
			rows: [{ id: "55555555-5555-4555-8555-555555555555" }],
		}),
	}),
}));

import { claudeCodeYSquaredAvailable } from "./y-mode";

const KEYS = [
	"YTIMESY_CLAUDE_RUNNER_URLS",
	"YTIMESY_CLAUDE_RUNNER_SIGNING_KEY",
	"YTIMESY_CLAUDE_RUNNER_USERS",
	"YTIMESY_CLAUDE_RUNNER_SESSIONS",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const key of KEYS)
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
});

function configure(users: string, sessions?: string) {
	process.env.YTIMESY_CLAUDE_RUNNER_URLS = "https://runner.example";
	process.env.YTIMESY_CLAUDE_RUNNER_SIGNING_KEY = "A".repeat(64);
	process.env.YTIMESY_CLAUDE_RUNNER_USERS = users;
	if (sessions === undefined) delete process.env.YTIMESY_CLAUDE_RUNNER_SESSIONS;
	else process.env.YTIMESY_CLAUDE_RUNNER_SESSIONS = sessions;
}

describe("claudeCodeYSquaredAvailable", () => {
	it("is false without runner configuration and true for any user once runners exist", async () => {
		for (const key of KEYS) delete process.env[key];
		expect(await claudeCodeYSquaredAvailable("alice")).toBe(false);
		expect(await claudeCodeYSquaredAvailable("alice", "s")).toBe(false);
		// Only runners matter for Y²: no user or chat has to be listed.
		configure("alice");
		expect(await claudeCodeYSquaredAvailable("alice")).toBe(true);
		expect(await claudeCodeYSquaredAvailable("alice", "any-chat")).toBe(true);
		expect(await claudeCodeYSquaredAvailable("bob")).toBe(true);
		configure("");
		expect(await claudeCodeYSquaredAvailable("carol", "any-chat")).toBe(true);
	});

	it("ignores the per-chat rollout list, which guards builders", async () => {
		configure("alice", "someone-elses-chat");
		expect(await claudeCodeYSquaredAvailable("alice", "other")).toBe(true);
		expect(await claudeCodeYSquaredAvailable("bob")).toBe(true);
	});
});

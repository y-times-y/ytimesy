import { describe, expect, it } from "vitest";
import {
	CLAUDE_RUNNER_DISALLOWED_TOOLS,
	claudeRunnerFor,
	claudeRunnerPrompt,
	claudeRunnerUrls,
} from "./claude-runner";

const env = {
	YTIMESY_CLAUDE_RUNNER_URLS:
		"https://runner-1.example.com, https://runner-2.example.com/",
	YTIMESY_CLAUDE_RUNNER_SECRET: "s".repeat(40),
	YTIMESY_CLAUDE_RUNNER_USERS: "u1,u2",
};
const chat = "11111111-1111-4111-8111-111111111111";

describe("claudeRunnerFor", () => {
	it("is off without its settings, for other users and for read-only helpers", () => {
		const base = { env, userId: "u1", sessionId: chat, reader: false };
		expect(claudeRunnerFor({ ...base, env: {} })).toBeNull();
		expect(
			claudeRunnerFor({
				...base,
				env: { ...env, YTIMESY_CLAUDE_RUNNER_SECRET: "short" },
			}),
		).toBeNull();
		expect(claudeRunnerFor({ ...base, userId: "u3" })).toBeNull();
		expect(claudeRunnerFor({ ...base, reader: true })).toBeNull();
		expect(
			claudeRunnerFor({
				...base,
				env: { ...env, YTIMESY_CLAUDE_RUNNER_USERS: "" },
			}),
		).toBeNull();
	});

	it("gives one chat the same box every time, and spreads chats over the boxes", () => {
		const pick = (sessionId: string) =>
			claudeRunnerFor({ env, userId: "u2", sessionId, reader: false })?.baseUrl;
		expect(pick(chat)).toBe(pick(chat));
		const seen = new Set(
			Array.from({ length: 40 }, (_, index) =>
				pick(`${index}`.padStart(8, "0") + chat.slice(8)),
			),
		);
		expect(seen).toEqual(
			new Set(["https://runner-1.example.com", "https://runner-2.example.com"]),
		);
	});

	it("lets everyone in with *", () => {
		expect(
			claudeRunnerFor({
				env: { ...env, YTIMESY_CLAUDE_RUNNER_USERS: "*" },
				userId: "anyone",
				sessionId: chat,
				reader: false,
			}),
		).not.toBeNull();
	});
});

describe("claudeRunnerUrls", () => {
	it("keeps only plain HTTPS origins", () => {
		expect(
			claudeRunnerUrls({
				YTIMESY_CLAUDE_RUNNER_URLS:
					"http://a.example.com,https://b.example.com/x,https://u:p@c.example.com,https://d.example.com,nonsense",
			}),
		).toEqual(["https://d.example.com"]);
	});
});

describe("the runner box setup", () => {
	it("turns off Claude's file and shell tools but not its own plan tool", () => {
		for (const name of ["Bash", "Read", "Edit", "Write", "Glob", "Grep"])
			expect(CLAUDE_RUNNER_DISALLOWED_TOOLS).toContain(name);
		expect(CLAUDE_RUNNER_DISALLOWED_TOOLS).not.toContain("TodoWrite");
	});

	it("tells the model where the code is, when to use run_code and to keep TodoWrite", () => {
		const text = claudeRunnerPrompt({
			repository: "/home/ubuntu/app",
			workspaceTools: ["read", "bash"],
			server: "ytimesy",
		}).join("\n");
		expect(text).toContain("/home/ubuntu/app");
		expect(text).toContain("mcp__ytimesy__read, mcp__ytimesy__bash");
		expect(text).toContain("mcp__ytimesy__run_code");
		expect(text).toContain("TodoWrite");
	});
});

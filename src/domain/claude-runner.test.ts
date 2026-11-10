import { describe, expect, it } from "vitest";
import {
	CLAUDE_RUNNER_DISALLOWED_TOOLS,
	claudeRunnerFor,
	claudeRunnerPrompt,
	claudeRunnerUrls,
	claudeWorkspaceCommandsPrompt,
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

	it("restricts a canary to named chats without moving other chats of the same user", () => {
		const canary = "57b2472e-fc46-4b0b-8df8-f14916a64b58";
		const base = {
			env: {
				...env,
				YTIMESY_CLAUDE_RUNNER_USERS: "*",
				YTIMESY_CLAUDE_RUNNER_SESSIONS: ` ${canary}, ${chat} `,
			},
			userId: "u2",
			reader: false,
		};
		expect(claudeRunnerFor({ ...base, sessionId: canary })).not.toBeNull();
		expect(claudeRunnerFor({ ...base, sessionId: chat })).not.toBeNull();
		expect(
			claudeRunnerFor({
				...base,
				sessionId: "dbba792d-b42d-4c89-80f5-7c655b737805",
			}),
		).toBeNull();
		expect(
			claudeRunnerFor({ ...base, sessionId: canary, reader: true }),
		).toBeNull();
	});

	it.each(["", " , ", "*"])(
		"fails closed for an empty or wildcard chat restriction %s",
		(sessions) => {
			expect(
				claudeRunnerFor({
					env: { ...env, YTIMESY_CLAUDE_RUNNER_SESSIONS: sessions },
					userId: "u1",
					sessionId: chat,
					reader: false,
				}),
			).toBeNull();
		},
	);

	it("keeps account authorization even when the chat is in the canary", () => {
		expect(
			claudeRunnerFor({
				env: { ...env, YTIMESY_CLAUDE_RUNNER_SESSIONS: chat },
				userId: "not-allowed",
				sessionId: chat,
				reader: false,
			}),
		).toBeNull();
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
		for (const name of [
			"Bash",
			"BashOutput",
			"KillBash",
			"KillShell",
			"Read",
			"Edit",
			"Write",
			"Glob",
			"Grep",
			"Task",
			"Agent",
			"TaskOutput",
			"TaskStop",
		])
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
		expect(text).toContain("background mechanism");
		expect(text).toContain("Do not bypass tracking");
	});
});

describe("claudeWorkspaceCommandsPrompt", () => {
	it("tells a writer about the browser and job commands", () => {
		const text = claudeWorkspaceCommandsPrompt({ reader: false }).join("\n");
		expect(text).toContain("ytimesy-browser");
		expect(text).toContain("screenshot");
		expect(text).toContain("exec");
		expect(text).toContain("ytimesy-job wait");
	});
	it("keeps a read-only helper to looking, not Python execution", () => {
		const text = claudeWorkspaceCommandsPrompt({ reader: true }).join("\n");
		expect(text).toContain("ytimesy-browser");
		expect(text).not.toContain("Browser Use CLI Python");
	});
});

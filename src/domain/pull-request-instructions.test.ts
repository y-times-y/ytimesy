import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemPrompt } from "../server/services/claude-code-runner";
import { leanToolInstructions } from "./lean-tool-instructions";
import { pullRequestNote } from "./pull-request-handoff-item";
import {
	PULL_REQUEST_INSTRUCTIONS,
	PULL_REQUEST_REMINDER,
} from "./pull-request-tools";

/** What taught agents to ask for a token or to open the pull request themselves. */
const BANNED = [
	/\bgh (auth|pr create|pr merge|repo)\b/i,
	/\bGH_TOKEN\b/,
	/GITHUB_TOKEN/,
	/gitlab mcp/i,
	/open (it|the pr|the pull request) yourself/i,
	/ask (the user )?for a (github )?token/i,
];

/** Files whose text is shown to a model; tests, the CLI and secret-pattern detectors are not. */
function instructionSources(dir: string, found: string[] = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) instructionSources(path, found);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
			found.push(path);
	}
	return found;
}

describe("pull request instructions", () => {
	it("tell the agent GitHub is connected, no token or gh, and what to say", () => {
		expect(PULL_REQUEST_INSTRUCTIONS).toMatch(/already connected/);
		expect(PULL_REQUEST_INSTRUCTIONS).toMatch(
			/never use `gh`, ask for a GH_TOKEN/,
		);
		expect(PULL_REQUEST_INSTRUCTIONS).toContain(
			"Pushed branch <name>; the pull request is opened automatically.",
		);
		expect(PULL_REQUEST_INSTRUCTIONS).toContain("request_push_approval");
		expect(PULL_REQUEST_INSTRUCTIONS.length).toBeLessThan(450);
	});

	it("reach the lean surfaces' prompt", () => {
		expect(
			leanToolInstructions("core", { gitRemote: true } as never),
		).toContain(PULL_REQUEST_INSTRUCTIONS);
	});

	it("are in every prompt builder's source", () => {
		for (const file of [
			"src/server/services/agent-turn-instructions.ts",
			"src/server/services/claude-code-runner.ts",
			"src/domain/lean-tool-instructions.ts",
		])
			expect(readFileSync(file, "utf8")).toContain("PULL_REQUEST_INSTRUCTIONS");
	});

	it("are not contradicted by any other model-facing text", () => {
		const own = "src/domain/pull-request-tools.ts";
		const offenders: string[] = [];
		for (const file of instructionSources("src")) {
			if (file === own) continue;
			const text = readFileSync(file, "utf8");
			for (const banned of BANNED)
				if (banned.test(text)) offenders.push(`${file}: ${banned}`);
		}
		// Allowed: detection of pasted secrets, the shell-title mapper and the
		// local-import CLI hand-off (the user's own machine, not the agent's).
		const allowed =
			/pasted-secrets\.ts|command-activity-title\.ts|github-credential-request\.ts|local-import/;
		expect(offenders.filter((line) => !allowed.test(line))).toEqual([]);
	});
});

describe("no pull request tool", () => {
	it("is added: the handoff does it server-side", () => {
		const tools = readFileSync("src/domain/pull-request-tools.ts", "utf8");
		expect(tools).not.toMatch(/open_pull_request|pull_request_status/);
	});
});

describe("pullRequestNote", () => {
	const opened = (id: string, number: number, draft = true) =>
		({
			kind: "notice",
			id,
			message: "Opened",
			pullRequest: {
				state: "opened",
				number,
				url: `https://github.com/acme/app/pull/${number}`,
				draft,
				created: true,
			},
		}) as never;

	it("quotes the newest handoff's number and link, null before any", () => {
		expect(pullRequestNote([])).toBeNull();
		const note = pullRequestNote([opened("a", 7), opened("b", 128)]);
		expect(note).toContain("draft PR #128");
		expect(note).toContain("https://github.com/acme/app/pull/128");
	});

	it("reaches the Claude Code system prompt and a resumed session's request", () => {
		const prompt = systemPrompt("/w", false, undefined, undefined, "NOTE-LINE");
		expect(prompt).toContain(PULL_REQUEST_INSTRUCTIONS);
		expect(prompt).toContain("NOTE-LINE");
		expect(PULL_REQUEST_REMINDER("NOTE-LINE")).toMatch(
			/no gh or token.*NOTE-LINE/,
		);
	});
});

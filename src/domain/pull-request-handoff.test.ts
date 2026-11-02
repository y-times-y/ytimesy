import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { EVIDENCE_END, EVIDENCE_START } from "./pr-evidence";
import {
	agentPullRequestDescription,
	changedPathsFromDiff,
	descriptionKeepingEvidence,
	handoffFactsFromItems,
	PULL_REQUEST_DESCRIPTION_MISSING,
	pullRequestHandoffBody,
	shouldReplacePullRequestBody,
} from "./pull-request-handoff";
import type { SessionItem } from "./session-item";

const written =
	"The parser rejects an empty token and reports the line number, so invalid input fails at the source.";

it("reads the agent's pull request description and ignores the old boilerplate", () => {
	expect(
		agentPullRequestDescription(
			`Done.\n\n<pull-request>\n${written}\n</pull-request>`,
		),
	).toBe(written);
	expect(
		agentPullRequestDescription(
			"<pull-request>Automatic draft handoff from ytimesy.</pull-request>",
		),
	).toBeNull();
	expect(agentPullRequestDescription("No block here.")).toBeNull();
});

it("publishes the agent's description, then files and checks it did not already name", () => {
	const body = pullRequestHandoffBody({
		description: written,
		finalAnswer: null,
		files: ["src/parser.ts"],
		verification: [{ command: "pnpm test", exitCode: 0 }],
	});
	expect(body.startsWith(written)).toBe(true);
	expect(body).toContain("`src/parser.ts`");
	expect(body).toContain("`pnpm test` (exit 0)");
	// The App's handle is in the footer ensureAppDraftPullRequest adds.
	expect(body).not.toContain("@ytimesy");
	expect(body).not.toContain("Automatic draft handoff");
});

it("assembles a specific body from the turn when the agent did not write one", () => {
	const body = pullRequestHandoffBody({
		description: null,
		finalAnswer:
			"Empty tokens used to parse as valid. The parser now rejects them and names the line. I ran the parser tests.",
		files: ["src/parser.ts", "1"],
		verification: [{ command: "pnpm test src/parser.test.ts", exitCode: 0 }],
	});
	expect(body).toContain("## Summary");
	expect(body).toContain("Empty tokens used to parse as valid");
	expect(body).toContain("`src/parser.ts`");
	expect(body).not.toContain("`1`");
	expect(body).toContain("exit 0");
	expect(body).not.toContain("Automatic draft handoff");
	expect(body).not.toContain("@ytimesy");
});

it("does not invent a description when the turn recorded nothing", () => {
	const body = pullRequestHandoffBody({
		description: null,
		finalAnswer: "Done.",
		files: [],
		verification: [],
	});
	expect(body).toBe(PULL_REQUEST_DESCRIPTION_MISSING);
	expect(body).not.toContain("@ytimesy");
});

it("keeps evidence and does not wipe a real description with a placeholder", () => {
	const evidence = `${EVIDENCE_START} sha=abc plan=auto -->\n## Evidence\n\nKept.\n${EVIDENCE_END}`;
	const current = `The parser rejects empty tokens.\n\n${evidence}`;
	expect(descriptionKeepingEvidence(current, written)).toBe(
		`${written}\n\n${evidence}`,
	);
	expect(
		shouldReplacePullRequestBody(current, PULL_REQUEST_DESCRIPTION_MISSING),
	).toBe(false);
	expect(
		shouldReplacePullRequestBody(
			"Automatic draft handoff from ytimesy. Review the changes and verification evidence before merging.",
			written,
		),
	).toBe(true);
	expect(shouldReplacePullRequestBody(current, written)).toBe(true);
});

it("collects the description, files, and checks from the latest request", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("old"),
			text: "Earlier",
		},
		{
			kind: "agentMessage",
			id: SessionItemId("old-answer"),
			text: "<pull-request>This is the previous turn's description of a different change.</pull-request>",
		},
		{
			kind: "userMessage",
			id: SessionItemId("new"),
			text: "Reject empty tokens",
		},
		{
			kind: "fileChange",
			id: SessionItemId("files"),
			status: "completed",
			changes: [
				{
					path: "src/parser.ts",
					change: "update",
					additions: 4,
					deletions: 1,
					preview: null,
				},
			],
		},
		{
			kind: "commandExecution",
			id: SessionItemId("ls"),
			command: "ls",
			cwd: null,
			status: "completed",
			output: "src",
			exitCode: 0,
		},
		{
			kind: "commandExecution",
			id: SessionItemId("test"),
			command: "pnpm test",
			cwd: null,
			status: "completed",
			output: "pass",
			exitCode: 0,
		},
		{
			kind: "agentMessage",
			id: SessionItemId("answer"),
			text: `Shipped.\n<pull-request>\n${written}\n</pull-request>`,
		},
	];
	expect(handoffFactsFromItems(items)).toEqual({
		description: written,
		finalAnswer: `Shipped.\n<pull-request>\n${written}\n</pull-request>`,
		files: ["src/parser.ts"],
		verification: [{ command: "pnpm test", exitCode: 0 }],
	});
	expect(changedPathsFromDiff("src/parser.ts\n1\n")).toEqual(["src/parser.ts"]);
});

import { describe, expect, it } from "vitest";
import {
	composerSlashCommands,
	expandProjectCommand,
	matchingSlashCommands,
	parseSlashDraft,
	projectCommandFromFile,
} from "./slash-command";

const connected = composerSlashCommands({
	authenticated: true,
	requiresAccountLogin: true,
	turnRunning: false,
	canSend: true,
	hasLastUserMessage: true,
	hasModels: true,
});

describe("slash commands", () => {
	it("parses /model with a trailing argument", () => {
		expect(parseSlashDraft("/model use this")).toEqual({
			query: "model",
			argument: "use this",
		});
	});

	it("filters commands from the first token", () => {
		const draft = parseSlashDraft("/st");
		expect(draft).not.toBeNull();
		expect(
			matchingSlashCommands(
				draft ?? { query: "", argument: "" },
				connected,
			).map((command) => command.trigger),
		).toEqual(["/stop"]);
	});

	it("asks OpenCode to connect instead of signing in", () => {
		const unsigned = composerSlashCommands({
			authenticated: false,
			requiresAccountLogin: false,
			turnRunning: false,
			canSend: false,
			hasLastUserMessage: false,
			hasModels: false,
		});
		expect(
			unsigned.find((command) => command.id === "model")?.unavailableReason,
		).toBe("Connect an agent to load models");
	});

	it("hides unavailable commands until they are typed", () => {
		expect(
			matchingSlashCommands({ query: "", argument: "" }, connected).map(
				(command) => command.id,
			),
		).toEqual(["retry", "model", "files", "diff", "terminal", "desktop"]);
	});
});

describe("repository commands", () => {
	it("reads name, frontmatter and template from a command file", () => {
		expect(
			projectCommandFromFile(
				".claude/commands/review-pr.md",
				'---\ndescription: "Review a pull request"\nargument-hint: <number>\n---\nReview PR #$1 for correctness.\n',
			),
		).toEqual({
			id: "custom",
			trigger: "/review-pr",
			label: "review-pr",
			description: "Review a pull request",
			availability: "ready",
			template: "Review PR #$1 for correctness.",
			argumentHint: "<number>",
		});
		expect(
			projectCommandFromFile(".agents/commands/fix.md", "Fix the build.\nMore")
				?.description,
		).toBe("Fix the build.");
	});

	it("ignores nested, unsafe, empty and built-in-shadowing files", () => {
		for (const path of [
			".claude/commands/nested/x.md",
			".claude/commands/../secret.md",
			".claude/commands/Upper.md",
			"commands/x.md",
			".claude/commands/stop.md",
		])
			expect(projectCommandFromFile(path, "Do it")).toBeNull();
		expect(
			projectCommandFromFile(".claude/commands/empty.md", "---\na: b\n---\n"),
		).toBeNull();
	});

	it("expands arguments into the template", () => {
		expect(expandProjectCommand("Fix $ARGUMENTS now", "the login bug")).toBe(
			"Fix the login bug now",
		);
		expect(expandProjectCommand("Compare $1 with $2", "main dev")).toBe(
			"Compare main with dev",
		);
		expect(expandProjectCommand("Summarize the repo", "focus on auth")).toBe(
			"Summarize the repo\n\nfocus on auth",
		);
		expect(expandProjectCommand("Summarize the repo", "")).toBe(
			"Summarize the repo",
		);
	});
});

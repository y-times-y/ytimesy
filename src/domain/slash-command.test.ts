import { describe, expect, it } from "vitest";
import {
	composerSlashCommands,
	exactSlashCommand,
	expandProjectCommand,
	matchingSlashCommands,
	parseSlashDraft,
	projectCommandFromFile,
	slashMenuCommands,
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
		).toEqual([
			"retry",
			"model",
			"files",
			"diff",
			"terminal",
			"desktop",
			"side",
		]);
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

describe("slash text that is a message", () => {
	const review = projectCommandFromFile(
		".claude/commands/review.md",
		"Review $ARGUMENTS",
	);
	const commands = [...connected, ...(review ? [review] : [])];
	const parse = (text: string) => {
		const draft = parseSlashDraft(text);
		if (!draft) throw new Error("not a slash draft");
		return draft;
	};

	it("runs only an exact command", () => {
		expect(exactSlashCommand(parse("/files"), commands)?.id).toBe("files");
		expect(exactSlashCommand(parse("/Files"), commands)?.id).toBe("files");
		expect(exactSlashCommand(parse("/fi"), commands)).toBeNull();
		// Project commands take an argument; built-ins do not.
		expect(exactSlashCommand(parse("/review src/a.ts"), commands)?.id).toBe(
			"custom",
		);
	});

	it("sends slash text that names no command as a message", () => {
		for (const text of [
			"/api/workspaces returns 500, fix it",
			"/files are missing",
			"/stop please",
		]) {
			expect(exactSlashCommand(parse(text), commands)).toBeNull();
			expect(slashMenuCommands(parse(text), commands)).toEqual([]);
		}
	});

	it("offers the menu while a command name is being typed", () => {
		expect(slashMenuCommands(parse("/fi"), commands)[0]?.id).toBe("files");
		expect(
			slashMenuCommands(parse("/review the auth flow"), commands),
		).toHaveLength(1);
	});
});

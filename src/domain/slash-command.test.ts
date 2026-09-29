import { describe, expect, it } from "vitest";
import {
	composerSlashCommands,
	matchingSlashCommands,
	parseSlashDraft,
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

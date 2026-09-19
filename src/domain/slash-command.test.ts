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
	it("parses /side with a trailing question", () => {
		expect(parseSlashDraft("/side why did this fail")).toEqual({
			query: "side",
			argument: "why did this fail",
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
			unsigned.find((command) => command.id === "side")?.unavailableReason,
		).toBe("Connect an agent to start a side chat");
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
			"side",
			"btw",
			"retry",
			"model",
			"files",
			"diff",
			"terminal",
			"desktop",
		]);
	});
});

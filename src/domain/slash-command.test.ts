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
	publicationReady: false,
});

describe("slash commands", () => {
	it("parses /side with a trailing question", () => {
		expect(parseSlashDraft("/side why did this fail")).toEqual({
			query: "side",
			argument: "why did this fail",
		});
	});

	it("keeps /pr unavailable until publication exists", () => {
		const pr = connected.find((command) => command.id === "pr");
		expect(pr?.availability).toBe("unavailable");
		expect(pr?.unavailableReason).toMatch(/GitHub publication/i);
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
			publicationReady: false,
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
		).toEqual(["side", "btw", "retry", "model", "diff", "terminal", "desktop"]);
	});
});

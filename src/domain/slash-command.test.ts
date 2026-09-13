import { describe, expect, it } from "vitest";
import {
	composerSlashCommands,
	matchingSlashCommands,
	parseSlashDraft,
} from "./slash-command";

const connected = composerSlashCommands({
	authenticated: true,
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

	it("keeps ready commands above unavailable ones", () => {
		expect(
			matchingSlashCommands({ query: "", argument: "" }, connected)[0]
				?.availability,
		).toBe("ready");
		expect(
			matchingSlashCommands({ query: "", argument: "" }, connected).at(-1)?.id,
		).toBe("pr");
	});
});

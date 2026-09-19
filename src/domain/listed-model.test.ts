import { describe, expect, it } from "vitest";
import {
	listedModelDisplayName,
	listedModelSupportsFastMode,
	listedModelPreferenceFromSessions,
	listedModelRestrictedByProvider,
	preferredListedModelId,
	sessionListedModelIsBlocked,
	submittedListedModelId,
	composerModelIdForCatalog,
} from "./listed-model";

describe("submittedListedModelId", () => {
	const listed = [
		{ id: "opencode/nemotron-3-ultra-free" },
		{ id: "opencode/muse-spark-1.3-contributor-free" },
		{ id: "opencode/big-pickle" },
	];

	it("keeps a requested id that the connected catalog listed", () => {
		expect(
			submittedListedModelId("opencode/nemotron-3-ultra-free", listed),
		).toBe("opencode/nemotron-3-ultra-free");
	});

	it("picks a listed Zen spark when the client has no model yet", () => {
		expect(submittedListedModelId("", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
		expect(submittedListedModelId("invented/not-listed", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
	});

	it("reuses the last listed id instead of re-preferring Zen spark", () => {
		expect(
			submittedListedModelId("", listed, {
				lastUsedId: "opencode/big-pickle",
			}),
		).toBe("opencode/big-pickle");
	});

	it("skips a listed Zen spark the provider already restricted", () => {
		expect(
			submittedListedModelId("", listed, {
				excludedIds: ["opencode/muse-spark-1.3-contributor-free"],
			}),
		).toBe("opencode/nemotron-3-ultra-free");
	});

	it("skips a requested spark the provider already restricted", () => {
		expect(
			submittedListedModelId(
				"opencode/muse-spark-1.3-contributor-free",
				listed,
				{
					lastUsedId: "opencode/big-pickle",
					excludedIds: ["opencode/muse-spark-1.3-contributor-free"],
				},
			),
		).toBe("opencode/big-pickle");
	});

	it("reuses the last listed id before the catalog loads", () => {
		expect(
			preferredListedModelId([], { lastUsedId: "opencode/big-pickle" }),
		).toBe("opencode/big-pickle");
		expect(
			submittedListedModelId("", [], { lastUsedId: "opencode/big-pickle" }),
		).toBe("opencode/big-pickle");
	});

	it("does not invent an id when the catalog is empty", () => {
		expect(submittedListedModelId("", [])).toBe("");
		expect(preferredListedModelId([])).toBe("");
	});
});

describe("composerModelIdForCatalog", () => {
	const opencode = [
		{ id: "opencode/muse-spark-1.3-contributor-free" },
		{ id: "opencode/big-pickle" },
	];
	const codex = [
		{ id: "gpt-5.3-codex-spark" },
		{ id: "gpt-5.3-codex" },
	];

	it("does not keep another provider's model after the catalog changes", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "opencode/big-pickle",
				catalog: codex,
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("gpt-5.3-codex-spark");
	});

	it("keeps the last model for the connected catalog", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "",
				catalog: opencode,
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("opencode/big-pickle");
	});

	it("shows no model name while the new provider catalog is empty", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "opencode/big-pickle",
				catalog: [],
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("");
	});
});

describe("listedModelPreferenceFromSessions", () => {
	it("reuses a later listed success after a provider-blocked spark turn", () => {
		expect(
			listedModelPreferenceFromSessions({
				harness: "opencode",
				sessions: [
					{
						harness: "opencode",
						listedModelId: "opencode/big-pickle",
						items: [
							{ kind: "userMessage", text: "try pickle" },
							{ kind: "agentMessage", text: "wrote PICKLE_PROOF.md" },
						],
					},
					{
						harness: "opencode",
						listedModelId: "opencode/muse-spark-1.3-contributor-free",
						items: [
							{
								kind: "error",
								message:
									"[user_blocked] Your access has been restricted due to repeated policy violations.",
							},
						],
					},
				],
			}),
		).toEqual({
			listedModelId: "opencode/big-pickle",
			blockedListedModelIds: ["opencode/muse-spark-1.3-contributor-free"],
		});
	});

	it("does not treat an earlier restriction as blocking a later listed success on the same session", () => {
		expect(
			sessionListedModelIsBlocked("opencode/big-pickle", [
				{
					kind: "error",
					message: "[user_blocked] Your access has been restricted",
				},
				{ kind: "userMessage", text: "use pickle" },
				{ kind: "agentMessage", text: "listed-big-pickle-follow-up" },
			]),
		).toBe(false);
		expect(
			listedModelRestrictedByProvider(
				"[user_blocked] Your access has been restricted due to repeated policy violations.",
			),
		).toBe(true);
	});
});

describe("listedModelSupportsFastMode", () => {
	it("only treats an explicit Fast flag as available", () => {
		expect(listedModelSupportsFastMode({})).toBe(false);
		expect(listedModelSupportsFastMode({ supportsFastMode: true })).toBe(true);
		expect(listedModelSupportsFastMode({ fast: true })).toBe(true);
		expect(listedModelSupportsFastMode({ supportsFastMode: "yes" })).toBe(
			false,
		);
	});
});

describe("listedModelDisplayName", () => {
	it("shows the catalog id tail without inventing a label", () => {
		expect(listedModelDisplayName("opencode/big-pickle")).toBe("big-pickle");
		expect(listedModelDisplayName("gpt-5.3-codex-spark")).toBe(
			"gpt-5.3-codex-spark",
		);
		expect(listedModelDisplayName("  ")).toBe("");
	});
});

import { describe, expect, it } from "vitest";
import { claudeCodeTurnRevision } from "./claude-code-route";
import {
	routeKey,
	stickyFallbackKey,
	type TurnFailover,
} from "./model-failover";

const claude = {
	connectionId: null,
	connectionRevision: claudeCodeTurnRevision(),
	modelId: "claude-opus-5-5",
};
const codex = {
	connectionId: null,
	connectionRevision: "subscription:v1",
	modelId: "gpt-6.2-sol",
};
const previous: TurnFailover = {
	route: codex,
	label: { model: "GPT-6.2-Sol", connection: "Codex" },
	tried: [routeKey(claude), routeKey(codex)],
	triedLabels: ["Claude Opus 5.5 · Claude Agent", "GPT-6.2-Sol · Codex"],
	switches: 1,
};
const now = Date.parse("2026-11-24T01:00:00Z");
const later = now + 60 * 60_000;

describe("a new turn while the chat's plan is still spent (2026-11-23: 338 repeated switch lines in one chat)", () => {
	it("starts on the fallback the last turn moved to", () => {
		expect(
			stickyFallbackKey({
				enabled: true,
				original: claude,
				previous,
				spentUntil: later,
				now,
			}),
		).toBe(routeKey(codex));
	});

	it("goes back to the chosen model once the plan has reset", () => {
		expect(
			stickyFallbackKey({
				enabled: true,
				original: claude,
				previous,
				spentUntil: now - 1,
				now,
			}),
		).toBeNull();
		expect(
			stickyFallbackKey({
				enabled: true,
				original: claude,
				previous,
				spentUntil: null,
				now,
			}),
		).toBeNull();
	});

	it("never when failover is off, the last turn did not leave this route, or there was no last switch", () => {
		expect(
			stickyFallbackKey({
				enabled: false,
				original: claude,
				previous,
				spentUntil: later,
				now,
			}),
		).toBeNull();
		const otherModel = { ...claude, modelId: "claude-sonnet-5-5" };
		expect(
			stickyFallbackKey({
				enabled: true,
				original: otherModel,
				previous,
				spentUntil: later,
				now,
			}),
		).toBeNull();
		expect(
			stickyFallbackKey({
				enabled: true,
				original: claude,
				previous: null,
				spentUntil: later,
				now,
			}),
		).toBeNull();
	});
});

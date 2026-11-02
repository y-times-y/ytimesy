import { expect, it } from "vitest";
import { apiTurnSettings } from "./api-turn-settings";

it("keeps only settings a turn can use", () => {
	expect(apiTurnSettings({ reasoning: "high", speed: "fast" })).toEqual({
		reasoning: "high",
		speed: "fast",
	});
	expect(apiTurnSettings({ reasoning: "", speed: "turbo" })).toEqual({});
	expect(apiTurnSettings(null)).toEqual({});
});

it("keeps the larger context window only when it was chosen", () => {
	expect(apiTurnSettings({ largeContext: true })).toEqual({
		largeContext: true,
	});
	expect(apiTurnSettings({ largeContext: "yes" })).toEqual({});
	expect(apiTurnSettings({ largeContext: false })).toEqual({});
});

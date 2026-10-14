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

import { describe, expect, it } from "vitest";
import {
	isOpenCodeZenAuthUrl,
	openCodeProviderIsConnected,
	openCodeZenAuthUrl,
	parseOpenCodeModelCatalog,
} from "./opencode-catalog";

describe("OpenCode catalog parsing", () => {
	it("loads model names from the connected server and keeps provider notices", () => {
		expect(
			parseOpenCodeModelCatalog({
				data: [
					{
						id: "opencode/big-pickle",
						modelID: "big-pickle",
						providerID: "opencode",
						name: "Big Pickle",
						warning: "Free period. Prompts may be used to improve the model.",
						timeLimited: true,
					},
					{
						id: "opencode/gpt-5.5",
						name: "GPT 5.5",
					},
				],
			}),
		).toEqual([
			{
				id: "opencode/big-pickle",
				label: "Big Pickle",
				notice:
					"Free period. Prompts may be used to improve the model. This free model is time-limited.",
			},
			{ id: "opencode/gpt-5.5", label: "GPT 5.5" },
		]);
	});

	it("reads provider maps without inventing models", () => {
		expect(
			parseOpenCodeModelCatalog({
				providers: [
					{
						id: "opencode",
						models: {
							"mimo-v2.5-free": {
								name: "MiMo-V2.5 Free",
								training: true,
							},
						},
					},
				],
			}),
		).toEqual([
			{
				id: "opencode/mimo-v2.5-free",
				label: "MiMo-V2.5 Free",
				notice: "This provider may use prompts for training.",
			},
		]);
		expect(parseOpenCodeModelCatalog({ providers: [] })).toEqual([]);
		expect(parseOpenCodeModelCatalog("not json")).toEqual([]);
	});

	it("treats OpenCode as connected only when the server says so", () => {
		expect(openCodeProviderIsConnected({ connected: ["opencode"] })).toBe(true);
		expect(openCodeProviderIsConnected({ connected: ["openai"] })).toBe(false);
		expect(openCodeZenAuthUrl()).toBe("https://opencode.ai/auth");
		expect(isOpenCodeZenAuthUrl("https://opencode.ai/auth")).toBe(true);
		expect(isOpenCodeZenAuthUrl("https://ytimesy.com/opencode")).toBe(false);
	});
});

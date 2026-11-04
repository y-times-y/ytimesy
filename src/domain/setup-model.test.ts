import { expect, it } from "vitest";
import { chooseSetupModel } from "./setup-model";

const codex = [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }];
const api = [{ id: "openrouter|anthropic/claude-opus-5.5" }];

it("runs setup on the model the person last used when its route still lists it", () => {
	expect(
		chooseSetupModel({
			lastUsed: { harnessId: "codex", modelId: "gpt-6-astra" },
			catalogs: { codex, api },
		}),
	).toEqual({ harnessId: "codex", modelId: "gpt-6-astra" });
	expect(
		chooseSetupModel({
			lastUsed: {
				harnessId: "api",
				modelId: "openrouter|anthropic/claude-opus-5.5",
			},
			catalogs: { codex, api },
		}),
	).toEqual({
		harnessId: "api",
		modelId: "openrouter|anthropic/claude-opus-5.5",
	});
});

it("takes the route's preferred model when the last one is gone, and the default route with no history", () => {
	expect(
		chooseSetupModel({
			lastUsed: { harnessId: "codex", modelId: "gpt-retired" },
			catalogs: { codex, api },
		}),
	).toEqual({ harnessId: "codex", modelId: "gpt-6.1-sol" });
	expect(
		chooseSetupModel({ lastUsed: null, catalogs: { codex, api } })?.harnessId,
	).toBe("codex");
});

it("falls back to another connected route when the last one is not connected", () => {
	expect(
		chooseSetupModel({
			lastUsed: { harnessId: "codex", modelId: "gpt-6.1-sol" },
			catalogs: { codex: [], api },
		}),
	).toEqual({
		harnessId: "api",
		modelId: "openrouter|anthropic/claude-opus-5.5",
	});
	expect(
		chooseSetupModel({
			lastUsed: {
				harnessId: "api",
				modelId: "openrouter|anthropic/claude-opus-5.5",
			},
			catalogs: { codex, api: [] },
		})?.harnessId,
	).toBe("codex");
});

it("has nothing to run setup on when no route is connected", () => {
	expect(
		chooseSetupModel({
			lastUsed: { harnessId: "codex", modelId: "gpt-6.1-sol" },
			catalogs: { codex: [], api: [] },
		}),
	).toBeNull();
});

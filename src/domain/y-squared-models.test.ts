import { describe, expect, it } from "vitest";
import { harnessForModelId } from "./model-harness";
import { Y_SQUARED_TOOLS, ySquaredInstructions } from "./y-squared";
import {
	canonicalReasoning,
	checkThreadModelSettings,
	modelListText,
	resolveThreadModel,
	type ThreadModel,
	type ThreadModelChoices,
} from "./y-squared-models";

const opus: ThreadModel = {
	id: "claude-code/claude-opus-5-5",
	label: "Claude Opus 5.5",
	harness: "api",
	route: "Claude Agent (Claude plan)",
	tier: "frontier",
	reasoning: ["low", "medium", "high"],
	defaultReasoning: "medium",
	speeds: [],
	usable: true,
};
const opusKey: ThreadModel = {
	...opus,
	id: "api/6c1f6a52-4f1e-4d1b-9a7e-3f2d9b1c0a11/anthropic%2Fclaude-opus-5.5",
	label: "Claude Opus 5.5 · OpenRouter",
	route: "OpenRouter (API key)",
};
const luna: ThreadModel = {
	id: "gpt-6-luna",
	label: "GPT-6 Luna",
	harness: "codex",
	route: "Codex (ChatGPT plan)",
	tier: "fast",
	reasoning: ["low", "high"],
	speeds: ["fast"],
	usable: true,
};
const spent: ThreadModel = {
	...luna,
	id: "gpt-6.2-sol",
	label: "GPT-6.2 Sol",
	tier: "frontier",
	usable: false,
	unavailable: "plan used up until 2026-11-25 03:40 UTC",
};
const models = [opus, opusKey, luna, spent];

describe("which model a request names", () => {
	it("matches a route id, an exact name and the bare model name", () => {
		for (const request of [
			opus.id,
			"Claude Opus 5.5",
			"claude  opus 5.5",
			"claude-opus-5-5",
		])
			expect(resolveThreadModel(request, models)).toEqual({
				ok: true,
				model: opus,
			});
		expect(resolveThreadModel(opusKey.id, models)).toEqual({
			ok: true,
			model: opusKey,
		});
	});

	it("takes the first usable route of a model on two routes", () => {
		const down = { ...opus, usable: false, unavailable: "plan used up" };
		expect(resolveThreadModel("Claude Opus 5.5", [down, opusKey])).toEqual({
			ok: true,
			model: opusKey,
		});
	});

	it("an exact route id never selects another route with the same bare model id", () => {
		const api = { ...luna, id: "api/connection/gpt-6-luna", route: "API key" };
		const unavailable = { ...luna, usable: false, unavailable: "plan used up" };
		expect(resolveThreadModel(luna.id, [api, luna])).toEqual({
			ok: true,
			model: luna,
		});
		const result = resolveThreadModel(luna.id, [api, unavailable]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("plan used up");
	});

	it("an unknown model is an error that lists the valid choices, never a fallback", () => {
		const picked = resolveThreadModel("gpt-9-ultra", models);
		expect(picked.ok).toBe(false);
		if (picked.ok) return;
		expect(picked.error).toContain('Unknown model "gpt-9-ultra"');
		expect(picked.error).toContain(`Claude Opus 5.5 (id ${opus.id})`);
		expect(picked.error).toContain("GPT-6 Luna (id gpt-6-luna)");
		// A model whose plan is used up is named as such, not offered.
		expect(picked.error).toContain(
			"Not usable now: GPT-6.2 Sol: plan used up until 2026-11-25 03:40 UTC",
		);
		expect(picked.error).not.toContain("(id gpt-6.2-sol)");
	});

	it("a model whose plan is used up is refused with the reason and the alternatives", () => {
		const picked = resolveThreadModel("GPT-6.2 Sol", models);
		expect(picked.ok).toBe(false);
		if (picked.ok) return;
		expect(picked.error).toContain(
			"GPT-6.2 Sol is not usable now: plan used up until 2026-11-25 03:40 UTC",
		);
		expect(picked.error).toContain("Models you can choose now:");
	});

	it("says so when nothing is usable or connected", () => {
		const none = resolveThreadModel("anything", []);
		expect(none).toMatchObject({ ok: false });
		expect(none.ok ? "" : none.error).toContain("No model is usable right now");
		const empty: ThreadModelChoices = {
			enabled: true,
			failover: true,
			models: [],
		};
		expect(modelListText(empty)).toContain("No model is connected");
	});
});

describe("reasoning and speed", () => {
	it("accept only what the model lists", () => {
		expect(checkThreadModelSettings(luna, { reasoning: "HIGH" })).toBeNull();
		expect(canonicalReasoning(luna, "HIGH")).toBe("high");
		expect(checkThreadModelSettings(luna, { speed: "fast" })).toBeNull();
		expect(checkThreadModelSettings(luna, { reasoning: "xhigh" })).toContain(
			"has reasoning low, high",
		);
		expect(checkThreadModelSettings(opus, { speed: "fast" })).toContain(
			"has no faster speed",
		);
		expect(
			checkThreadModelSettings(
				{ ...opus, reasoning: [] },
				{ reasoning: "low" },
			),
		).toContain("has no reasoning setting");
	});
});

describe("list_models text", () => {
	const text = modelListText({ enabled: true, failover: false, models });
	it("gives route, strength note, usability, reasoning and speed per model", () => {
		expect(text).toContain(
			`- ${opus.id} — Claude Opus 5.5 · runs on Claude Agent (Claude plan) · strongest; slower and costlier · usable now · reasoning: low/medium/high (default medium)`,
		);
		expect(text).toContain("fastest and cheapest");
		expect(text).toContain("speed: fast");
		expect(text).toContain(
			"NOT usable now: plan used up until 2026-11-25 03:40 UTC",
		);
	});
	it("says whether failover is on", () => {
		expect(text).toContain("Automatic failover is OFF");
		expect(modelListText({ enabled: true, failover: true, models })).toContain(
			"Automatic failover is ON",
		);
	});
	it("says the setting is off when it is", () => {
		expect(modelListText({ enabled: false, failover: true, models })).toContain(
			"switched off for this project",
		);
	});
	it("marks a plan that is nearly used up", () => {
		expect(
			modelListText({
				enabled: true,
				failover: true,
				models: [{ ...luna, nearlySpent: true }],
			}),
		).toContain("usable, but its plan is nearly used up");
	});
});

describe("which runtime a model runs on", () => {
	it("API keys and the Claude plan are api; every other id is Codex", () => {
		expect(harnessForModelId(opus.id)).toBe("api");
		expect(harnessForModelId(opusKey.id)).toBe("api");
		expect(harnessForModelId("gpt-6-luna")).toBe("codex");
		expect(harnessForModelId("")).toBeNull();
	});
});

describe("list_models carries the one-line tier hint", () => {
	it("says strongest, balanced or fastest and cheapest for each model", async () => {
		const { tierNote } = await import("./y-squared-models");
		expect(tierNote("frontier")).toBe("strongest; slower and costlier");
		expect(tierNote("balanced")).toContain("moderate speed and cost");
		expect(tierNote("fast")).toBe("fastest and cheapest; lighter reasoning");
		expect(tierNote(null)).toBe("not rated");
	});
});

describe("Y²'s selection policy", () => {
	const text = ySquaredInstructions();
	it("names the tools and the rules", () => {
		expect(Y_SQUARED_TOOLS.has("list_models")).toBe(true);
		expect(Y_SQUARED_TOOLS.has("set_thread_model")).toBe(true);
		expect(text).toContain("`set_thread_model`");
		expect(text).toContain("`list_models`");
		expect(text).toContain("named model wins, exactly");
		expect(text).toContain("infrastructure, deploys, migrations, security");
		expect(text).toContain("research, read-only investigation, summaries");
		expect(text).toContain("nearly used");
		expect(text).toContain("Failover stays the safety net");
		expect(text).toContain("say it in one line");
		expect(text).toContain("never retry another model unasked");
	});

	it("picks per task by tier and class, and changes the model when the job changes", () => {
		expect(text).toContain("Haiku-class");
		expect(text).toContain("Sonnet");
		expect(text).toContain("Opus");
		expect(text).toContain("fast tier");
		expect(text).toContain("balanced");
		expect(text).toContain("frontier");
		expect(text).toContain("When a thread's job changes");
		expect(text).not.toContain("the default is right most of the time");
	});

	it("sizes the brief to the task (small, medium, large) and states the effort", () => {
		expect(text).toContain("Size the brief to the task");
		expect(text).toContain("Small");
		expect(text).toContain("Medium");
		expect(text).toContain("Large");
		expect(text).toContain("no audits, no headed-browser runs");
		expect(text).toContain("state the expected effort");
	});

	it("both blocks stay compact (about 150 tokens each)", () => {
		const block = (start: string) => {
			const from = text.indexOf(start);
			return text.slice(from, text.indexOf("\n", from));
		};
		expect(block("- Choosing a thread's model").length / 4).toBeLessThan(240);
		expect(block("- Size the brief to the task").length / 4).toBeLessThan(160);
	});
});

describe("the policy and the rubric reach every route", () => {
	it("are in the one instruction text the API, Codex, Grok, box and Claude runner prompts all use", async () => {
		const { ySquaredInstructions: build } = await import("./y-squared");
		const text = build();
		for (const part of [
			"Size the brief to the task",
			"- Choosing a thread's model",
		])
			expect(text).toContain(part);
	});
});

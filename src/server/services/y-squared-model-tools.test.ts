import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { wakeMessageId } from "#/domain/pull-request-wake";
import type {
	ThreadModel,
	ThreadModelChoices,
} from "#/domain/y-squared-models";
import { ySquaredTools } from "./y-squared-tools";

const run = (
	tools: ReturnType<typeof ySquaredTools>,
	name: string,
	input: unknown,
) =>
	(
		tools[name] as {
			execute: (input: unknown, options: unknown) => Promise<string>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

const model = (patch: Partial<ThreadModel> & { id: string }): ThreadModel => ({
	label: patch.id,
	harness: "api",
	route: "Claude Agent (Claude plan)",
	tier: null,
	reasoning: [],
	speeds: [],
	usable: true,
	...patch,
});
const OPUS = model({
	id: "claude-code/claude-opus-5-5",
	label: "Claude Opus 5.5",
	tier: "frontier",
	reasoning: ["low", "medium", "high"],
});
const LUNA = model({
	id: "gpt-6-luna",
	label: "GPT-6 Luna",
	harness: "codex",
	route: "Codex (ChatGPT plan)",
	tier: "fast",
	speeds: ["fast"],
});
const SOL = model({
	id: "gpt-6.2-sol",
	label: "GPT-6.2 Sol",
	harness: "codex",
	route: "Codex (ChatGPT plan)",
	usable: false,
	unavailable: "plan used up until 2026-11-25 03:40 UTC",
});

const chat = (patch: Record<string, unknown>) => ({
	projectId: "p",
	parentSessionId: null,
	agentRole: null,
	harness: "codex",
	listedModelId: "gpt-6-sol",
	turnStatus: "idle",
	title: "Fix the thing",
	...patch,
});

function fixture(
	options: {
		choices?: Partial<ThreadModelChoices>;
		chats?: Record<string, Record<string, unknown>>;
	} = {},
) {
	const chats = options.chats ?? {
		idle: chat({ id: "idle" }),
		busy: chat({ id: "busy", turnStatus: "running" }),
		foreign: chat({ id: "foreign", projectId: "other" }),
		helper: chat({
			id: "helper",
			parentSessionId: "idle",
			agentRole: "writer",
		}),
	};
	const send = vi.fn(async () => ({
		turnStatus: "running",
		sessionId: "new-thread",
	}));
	const stop = vi.fn(async () => ({ turnStatus: "idle" }));
	const setModel = vi.fn(async () => ({ found: true, lineWritten: true }));
	const models = vi.fn(
		async (): Promise<ThreadModelChoices> => ({
			enabled: true,
			failover: true,
			models: [OPUS, LUNA, SOL],
			...options.choices,
		}),
	);
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		machines: {} as never,
		modelId: "gpt-6-sol",
		harnessId: "codex",
		turnId: "turn-1",
		deps: {
			crew: () => null,
			metadata: (async (_user: string, id: string) =>
				id === "y2"
					? chat({ id: "y2", harness: "api" })
					: (chats[id] ?? null)) as never,
			send: send as never,
			stop: stop as never,
			setModel: setModel as never,
			models,
		},
	});
	return { tools, send, stop, setModel, models };
}

describe("start_thread idempotency", () => {
	const keyFor = async (settings: Record<string, string> = {}) => {
		const f = fixture();
		await run(f.tools, "start_thread", {
			title: "Audit",
			brief: "Inspect cache.",
			...settings,
		});
		expect(f.send).toHaveBeenCalledOnce();
		return (
			f.send.mock.calls[0] as unknown as [
				unknown,
				unknown,
				{ idempotencyKey: string },
			]
		)[2].idempotencyKey;
	};

	it("keeps the legacy key when no model is chosen", async () => {
		const hash = createHash("sha256")
			.update(["Audit", "Inspect cache."].join("\u0000"))
			.digest("hex");
		expect(await keyFor()).toBe(wakeMessageId(`y2-start:turn-1:${hash}`));
	});

	it("distinguishes explicit models, reasoning and speed but deduplicates retries", async () => {
		const defaultKey = await keyFor();
		const opus = await keyFor({ model: "Claude Opus 5.5" });
		const high = await keyFor({ model: "Claude Opus 5.5", reasoning: "HIGH" });
		const medium = await keyFor({
			model: "Claude Opus 5.5",
			reasoning: "medium",
		});
		const luna = await keyFor({ model: "gpt-6-luna" });
		const fast = await keyFor({ model: "gpt-6-luna", speed: "fast" });
		expect(new Set([defaultKey, opus, high, medium, luna, fast]).size).toBe(6);
		expect(
			await keyFor({ model: "claude-code/claude-opus-5-5", reasoning: "high" }),
		).toBe(high);
		expect(await keyFor({ model: "GPT-6 Luna", speed: "FAST" })).toBe(fast);
	});
});

describe("start_thread with a model", () => {
	it("starts the thread on the chosen model and its runtime, with reasoning", async () => {
		const f = fixture();
		const result = await run(f.tools, "start_thread", {
			title: "Prod migration",
			brief: "Run the migration.",
			model: "Claude Opus 5.5",
			reasoning: "HIGH",
		});
		expect(result).toContain("Started");
		expect(result).toContain("on Claude Opus 5.5 (Claude Agent (Claude plan))");
		expect(f.send).toHaveBeenCalledOnce();
		const [, scope, sent] = f.send.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
			Record<string, unknown>,
		];
		// The model decides the runtime: a Codex-default Y² starts an api thread.
		expect(scope).toMatchObject({ harnessId: "api", createNew: true });
		expect(sent).toMatchObject({
			modelId: "claude-code/claude-opus-5-5",
			variant: "high",
		});
	});

	it("a faster speed reaches a Codex model as its fast mode", async () => {
		const f = fixture();
		await run(f.tools, "start_thread", {
			title: "Lookup",
			brief: "Find the owner of X.",
			model: "gpt-6-luna",
			speed: "fast",
		});
		const [, scope, sent] = f.send.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
			Record<string, unknown>,
		];
		expect(scope).toMatchObject({ harnessId: "codex" });
		expect(sent).toMatchObject({ modelId: "gpt-6-luna", fast: true });
	});

	it("without a model it is today's default: Y²'s own route, no model lookup", async () => {
		const f = fixture();
		await run(f.tools, "start_thread", { title: "T", brief: "B" });
		const [, scope, sent] = f.send.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
			Record<string, unknown>,
		];
		expect(scope).toMatchObject({ harnessId: "codex" });
		expect(sent.modelId).toBe("gpt-6-sol");
		expect(sent).not.toHaveProperty("variant");
		expect(f.models).not.toHaveBeenCalled();
	});

	it("an unknown model starts nothing and lists the valid choices", async () => {
		const f = fixture();
		const result = await run(f.tools, "start_thread", {
			title: "T",
			brief: "B",
			model: "gpt-9-ultra",
		});
		expect(result).toContain("Not started");
		expect(result).toContain('Unknown model "gpt-9-ultra"');
		expect(result).toContain("Claude Opus 5.5");
		expect(result).toContain("GPT-6 Luna");
		expect(f.send).not.toHaveBeenCalled();
	});

	it("a model whose plan is used up starts nothing and says why", async () => {
		const f = fixture();
		const result = await run(f.tools, "start_thread", {
			title: "T",
			brief: "B",
			model: "GPT-6.2 Sol",
		});
		expect(result).toContain("not usable now: plan used up until");
		expect(f.send).not.toHaveBeenCalled();
	});

	it("an unsupported reasoning level or a reasoning without a model starts nothing", async () => {
		const f = fixture();
		expect(
			await run(f.tools, "start_thread", {
				title: "T",
				brief: "B",
				model: "gpt-6-luna",
				reasoning: "high",
			}),
		).toContain("has no reasoning setting");
		expect(
			await run(f.tools, "start_thread", {
				title: "T",
				brief: "B",
				reasoning: "high",
			}),
		).toContain("pass model too");
		expect(f.send).not.toHaveBeenCalled();
	});

	it("is refused while the person turned model choice off", async () => {
		const f = fixture({ choices: { enabled: false } });
		const result = await run(f.tools, "start_thread", {
			title: "T",
			brief: "B",
			model: "Claude Opus 5.5",
		});
		expect(result).toContain("switched off for this project");
		expect(f.send).not.toHaveBeenCalled();
		// Starting with no model still works.
		await run(f.tools, "start_thread", { title: "T", brief: "B" });
		expect(f.send).toHaveBeenCalledOnce();
	});
});

describe("set_thread_model", () => {
	it("changes an idle thread from its next turn and records one quiet line", async () => {
		const f = fixture();
		const result = await run(f.tools, "set_thread_model", {
			id: "idle",
			model: "Claude Opus 5.5",
			reasoning: "high",
		});
		expect(result).toContain(
			'"Fix the thing" will use Claude Opus 5.5 (Claude Agent (Claude plan)), reasoning high from its next turn',
		);
		expect(result).toContain("conversation and checkpoint stay");
		expect(f.stop).not.toHaveBeenCalled();
		expect(f.setModel).toHaveBeenCalledOnce();
		expect(f.setModel.mock.calls[0]?.[0]).toMatchObject({
			userId: "u",
			projectId: "p",
			sessionId: "idle",
			modelId: "claude-code/claude-opus-5-5",
			harness: "api",
			variant: "high",
			line: "Model changed to Claude Opus 5.5 by the Super agent",
		});
	});

	it("a working thread keeps its running turn: refused unless interrupt, which stops it first", async () => {
		const f = fixture();
		const refused = await run(f.tools, "set_thread_model", {
			id: "busy",
			model: "gpt-6-luna",
		});
		expect(refused).toContain("is working");
		expect(refused).toContain("interrupt true");
		expect(f.setModel).not.toHaveBeenCalled();
		expect(f.stop).not.toHaveBeenCalled();

		const done = await run(f.tools, "set_thread_model", {
			id: "busy",
			model: "gpt-6-luna",
			interrupt: true,
		});
		expect(done).toContain("running turn was stopped first");
		expect(f.stop).toHaveBeenCalledOnce();
		expect(f.setModel).toHaveBeenCalledOnce();
		expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(
			f.setModel.mock.invocationCallOrder[0] as number,
		);
	});

	it("says so when a queued message restarted the thread before the line could be written", async () => {
		const f = fixture();
		f.setModel.mockResolvedValueOnce({ found: true, lineWritten: false });
		const result = await run(f.tools, "set_thread_model", {
			id: "busy",
			model: "gpt-6-luna",
			interrupt: true,
		});
		expect(result).toContain("A turn had already started again");
	});

	it("an unknown, used-up or unsupported choice changes nothing", async () => {
		const f = fixture();
		for (const [model, extra, expected] of [
			["gpt-9-ultra", {}, "Unknown model"],
			["GPT-6.2 Sol", {}, "not usable now"],
			["Claude Opus 5.5", { speed: "fast" }, "has no faster speed"],
		] as const)
			expect(
				await run(f.tools, "set_thread_model", { id: "idle", model, ...extra }),
			).toContain(expected);
		expect(f.setModel).not.toHaveBeenCalled();
	});

	it("is refused for another project's thread, a helper chat, a missing thread and the Super agent", async () => {
		const f = fixture();
		for (const id of ["foreign", "helper", "nope"])
			expect(
				await run(f.tools, "set_thread_model", { id, model: "gpt-6-luna" }),
			).toBe("No such thread in this project.");
		expect(
			await run(f.tools, "set_thread_model", { id: "y2", model: "gpt-6-luna" }),
		).toContain("Super agent itself");
		expect(f.setModel).not.toHaveBeenCalled();
		expect(f.models).not.toHaveBeenCalled();
	});

	it("resets omitted settings on the same model, and does nothing when the setting is off", async () => {
		const same = fixture({
			chats: { idle: chat({ id: "idle", listedModelId: "gpt-6-luna" }) },
		});
		expect(
			await run(same.tools, "set_thread_model", {
				id: "idle",
				model: "GPT-6 Luna",
			}),
		).toContain("will use GPT-6 Luna");
		expect(same.setModel).toHaveBeenCalledOnce();
		expect(same.setModel.mock.calls[0]?.[0]).not.toHaveProperty("variant");
		expect(same.setModel.mock.calls[0]?.[0]).not.toHaveProperty("speed");
		const off = fixture({ choices: { enabled: false } });
		expect(
			await run(off.tools, "set_thread_model", {
				id: "idle",
				model: "GPT-6 Luna",
			}),
		).toContain("switched off for this project");
		expect(off.setModel).not.toHaveBeenCalled();
	});

	it("reports a thread that vanished meanwhile as missing", async () => {
		const f = fixture();
		f.setModel.mockResolvedValueOnce({ found: false, lineWritten: false });
		expect(
			await run(f.tools, "set_thread_model", {
				id: "idle",
				model: "gpt-6-luna",
			}),
		).toBe("No such thread in this project.");
	});
});

describe("after a model change", () => {
	it("message_thread and retry_thread send on the thread's new model and its runtime", async () => {
		const f = fixture({
			chats: {
				moved: chat({
					id: "moved",
					harness: "codex",
					listedModelId: "claude-code/claude-opus-5-5",
				}),
				failed: chat({
					id: "failed",
					harness: "codex",
					listedModelId: "claude-code/claude-opus-5-5",
					turnStatus: "failed",
				}),
			},
		});
		await run(f.tools, "message_thread", { id: "moved", text: "go on" });
		await run(f.tools, "retry_thread", { id: "failed" });
		for (const call of f.send.mock.calls) {
			const [, scope, sent] = call as unknown as [
				unknown,
				Record<string, unknown>,
				Record<string, unknown>,
			];
			expect(scope).toMatchObject({ harnessId: "api" });
			expect(sent.modelId).toBe("claude-code/claude-opus-5-5");
		}
		expect(f.send).toHaveBeenCalledTimes(2);
	});
});

describe("list_models", () => {
	it("shows route, strength, usability and failover; nothing is hidden when a plan is spent", async () => {
		const f = fixture({ choices: { failover: false } });
		const text = await run(f.tools, "list_models", {});
		expect(text).toContain("Automatic failover is OFF");
		expect(text).toContain("Claude Agent (Claude plan)");
		expect(text).toContain("strongest; slower and costlier");
		expect(text).toContain("NOT usable now: plan used up until");
	});
});

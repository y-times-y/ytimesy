import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atifTrajectory, type TimedEvent } from "../evals/harbor_v2/atif";
import { harborBridgeConfig } from "../evals/harbor_v2/config";
import {
	committedUsd,
	ledgerSummary,
	reserveTrial,
	SpendCapReached,
	settleTrial,
	trialSpendGuard,
} from "../evals/harbor_v2/spend";
import {
	guardedFetch,
	streamKind,
	terminalEvent,
} from "../evals/harbor_v2/transport-guard";
import { modelBilling } from "../src/domain/model-pricing";

const base = {
	YTIMESY_HARBOR_ROUTE: "anthropic",
	YTIMESY_HARBOR_APPROVED: "anthropic",
};
const capped = {
	...base,
	YTIMESY_HARBOR_TOTAL_USD_CAP: "10",
	YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/ledger.jsonl",
};

describe("harborBridgeConfig", () => {
	it("defaults to the product's lean surface, max effort and a trial cap of $20 or the total", () => {
		const config = harborBridgeConfig(capped);
		expect(config).toMatchObject({
			route: "anthropic",
			modelId: "claude-opus-5-5",
			effort: "max",
			trialUsdCap: 10,
			total: { ledger: "/tmp/ledger.jsonl", capUsd: 10 },
			requestLimit: 400,
			webSearch: true,
			keyFile: ".secrets/anthropic-api-key",
			keyEnv: "ANTHROPIC_API_KEY",
		});
		expect(config.variant.toolSurface).toBe("lean");
		expect(config.billing.price).toMatchObject({ input: 4, output: 20 });
		expect(
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_TOTAL_USD_CAP: "50" })
				.trialUsdCap,
		).toBe(20);
	});

	it("requires the route's own approval", () => {
		expect(() =>
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_APPROVED: "openai-api" }),
		).toThrow(/YTIMESY_HARBOR_APPROVED=anthropic/);
		expect(() =>
			harborBridgeConfig({ YTIMESY_HARBOR_ROUTE: "bedrock" }),
		).toThrow(/must be one of/);
	});

	it("refuses a paid route without a total cap, and a trial cap above it", () => {
		expect(() => harborBridgeConfig(base)).toThrow(/needs a total cap/);
		expect(() =>
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_TRIAL_USD_CAP: "11" }),
		).toThrow(/cannot exceed the total cap/);
		expect(() =>
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_TRIAL_USD_CAP: "0" }),
		).toThrow(/positive dollar amount/);
	});

	it("refuses an unpriced model on a paid route", () => {
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_MODEL: "claude-opus-9-9",
			}),
		).toThrow(/No list price/);
	});

	it("passes supported variants through and refuses ones that need the product's job stack", () => {
		const config = harborBridgeConfig({
			...capped,
			YTIMESY_HARBOR_VARIANT: "toolSurface=lean-native,review=on,codeMode=on",
		});
		expect(config.variant).toMatchObject({
			toolSurface: "lean-native",
			review: "on",
			codeMode: "on",
		});
		expect(() =>
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_VARIANT: "attempts=3" }),
		).toThrow(/does not implement attempts/);
		expect(() =>
			harborBridgeConfig({ ...capped, YTIMESY_HARBOR_VARIANT: "subagents=on" }),
		).toThrow(/does not implement subagents/);
	});

	it("lets the plan-billed subscription run without a cap, at list-price estimates", () => {
		const config = harborBridgeConfig({
			YTIMESY_HARBOR_ROUTE: "codex-subscription",
			YTIMESY_HARBOR_APPROVED: "codex-subscription",
		});
		expect(config).toMatchObject({
			modelId: "gpt-6.1-sol",
			trialUsdCap: null,
			total: null,
			keyFile: null,
		});
		expect(config.billing.kind).toBe("plan");
	});

	it("prices the Gemini route", () => {
		const config = harborBridgeConfig({
			YTIMESY_HARBOR_ROUTE: "gemini",
			YTIMESY_HARBOR_APPROVED: "gemini",
			YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
			YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/l",
			YTIMESY_HARBOR_TRIAL_USD_CAP: "0.5",
		});
		expect(config.modelId).toBe("gemini-3.8-flash");
		expect(config.billing.price).not.toBeNull();
	});
});

describe("trial spend guard", () => {
	const billing = modelBilling({ harness: "api", modelId: "claude-opus-5-5" });
	it("refuses the request after the cap is reached and names why", () => {
		let usage = {
			inputTokens: 0,
			outputTokens: 0,
			uncachedInputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const guard = trialSpendGuard({
			billing,
			capUsd: 1,
			requestLimit: 10,
			usage: () => usage,
		});
		guard.beforeRequest();
		usage = { ...usage, inputTokens: 250_000, uncachedInputTokens: 250_000 };
		expect(() => guard.beforeRequest()).toThrow(SpendCapReached);
		expect(guard.stopReason()).toMatch(/\$1\.0000 of \$1/);
		expect(guard.requests()).toBe(1);
	});

	it("enforces the request limit", () => {
		const guard = trialSpendGuard({
			billing,
			capUsd: null,
			requestLimit: 2,
			usage: () => null,
		});
		guard.beforeRequest();
		guard.beforeRequest();
		expect(() => guard.beforeRequest()).toThrow(/request limit/);
	});
});

describe("spend ledger", () => {
	let directory: string;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("reserves each trial's cap, settles actual spend and refuses past the total", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-ledger-"));
		const ledger = join(directory, "nested", "ledger.jsonl");
		await reserveTrial({ ledger, totalCapUsd: 10, trial: "a", trialCapUsd: 4 });
		await reserveTrial({ ledger, totalCapUsd: 10, trial: "b", trialCapUsd: 4 });
		// 4 + 4 reserved: a third $4 trial would exceed $10.
		await expect(
			reserveTrial({ ledger, totalCapUsd: 10, trial: "c", trialCapUsd: 4 }),
		).rejects.toThrow(SpendCapReached);
		await settleTrial({ ledger, trial: "a", usd: 0.5 });
		expect((await ledgerSummary(ledger)).committedUsd).toBeCloseTo(4.5);
		await reserveTrial({ ledger, totalCapUsd: 10, trial: "c", trialCapUsd: 4 });
		await expect(
			reserveTrial({ ledger, totalCapUsd: 10, trial: "c", trialCapUsd: 1 }),
		).rejects.toThrow(/already in the spend ledger/);
		// An unknown estimate settles at the reservation.
		await settleTrial({ ledger, trial: "b", usd: Number.NaN });
		expect((await ledgerSummary(ledger)).committedUsd).toBeCloseTo(8.5);
	});

	it("serializes concurrent reservations so the total is never overcommitted", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-ledger-"));
		const ledger = join(directory, "ledger.jsonl");
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, index) =>
				reserveTrial({
					ledger,
					totalCapUsd: 10,
					trial: `t${index}`,
					trialCapUsd: 3,
				}),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(3);
		const lines = (await readFile(ledger, "utf8")).trim().split("\n");
		expect(committedUsd(lines.map((line) => JSON.parse(line)))).toBe(9);
	});

	it("refuses every new trial once the stop file exists", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-ledger-"));
		const ledger = join(directory, "ledger.jsonl");
		await writeFile(`${ledger}.stop`, "");
		await expect(
			reserveTrial({ ledger, totalCapUsd: 10, trial: "a", trialCapUsd: 1 }),
		).rejects.toThrow(/stopped new trials/);
	});
});

const sse = (lines: string[]) =>
	`${lines.map((line) => `data: ${line}`).join("\n\n")}\n\n`;
function streamOf(text: string, cut?: Error) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			if (cut) controller.error(cut);
			else controller.close();
		},
	});
}

describe("transport guard", () => {
	it("recognizes each provider's streamed requests", () => {
		const stream = '{"model":"m","stream":true}';
		expect(streamKind("https://api.openai.com/v1/responses", stream)).toBe(
			"openai",
		);
		expect(
			streamKind("https://chatgpt.com/backend-api/codex/responses", stream),
		).toBe("openai");
		expect(streamKind("https://api.anthropic.com/v1/messages", stream)).toBe(
			"anthropic",
		);
		expect(
			streamKind(
				"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
				"{}",
			),
		).toBe("google");
		expect(
			streamKind("https://api.anthropic.com/v1/messages", '{"stream":false}'),
		).toBeNull();
		expect(
			streamKind("https://api.anthropic.com/v1/messages/count_tokens", stream),
		).toBeNull();
	});

	it("finds each provider's terminal event", () => {
		expect(terminalEvent("anthropic", '{"type":"message_stop"}')).toEqual({
			type: "message_stop",
		});
		expect(
			terminalEvent(
				"anthropic",
				'{"type":"error","error":{"type":"overloaded_error"}}',
			),
		).toMatchObject({ type: "error" });
		expect(
			terminalEvent("anthropic", '{"type":"content_block_delta"}'),
		).toBeNull();
		expect(
			terminalEvent(
				"openai",
				'{"type":"response.completed","response":{"status":"completed"}}',
			),
		).toMatchObject({ type: "response.completed", status: "completed" });
		expect(
			terminalEvent("openai", '{"type":"response.output_text.delta"}'),
		).toBeNull();
		expect(
			terminalEvent(
				"google",
				'{"candidates":[{"content":{},"finishReason":"STOP"}]}',
			),
		).toMatchObject({ type: "finish", status: "STOP" });
		expect(
			terminalEvent("google", '{"candidates":[{"content":{}}]}'),
		).toBeNull();
	});

	it("resends an Anthropic stream that closed without message_stop, and the caller sees only the complete one", async () => {
		const complete = sse([
			'{"type":"message_start"}',
			'{"type":"content_block_delta","delta":{"text":"hi"}}',
			'{"type":"message_stop"}',
		]);
		const cut = sse([
			'{"type":"message_start"}',
			'{"type":"content_block_delta"}',
		]);
		const bodies = [cut, complete];
		let calls = 0;
		const fetch = guardedFetch(
			async () =>
				new Response(streamOf(bodies[calls++]), {
					status: 200,
					headers: { "request-id": `req_${calls}` },
				}),
			{ delayMs: () => 0 },
		);
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: '{"stream":true}',
		});
		expect(calls).toBe(2);
		expect(await response.text()).toBe(complete);
	});

	it("gives back the last partial stream when every attempt is cut, and logs each cut", async () => {
		const directory = await mkdtemp(join(tmpdir(), "harbor-guard-"));
		try {
			const log = join(directory, "transport.log");
			const cut = sse(['{"type":"response.created"}']);
			let calls = 0;
			const fetch = guardedFetch(
				async () => {
					calls++;
					return new Response(streamOf(cut), { status: 200 });
				},
				{ delayMs: () => 0, logPath: log, maxAttempts: 3 },
			);
			const response = await fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: '{"stream":true,"input":[]}',
			});
			expect(calls).toBe(3);
			expect(await response.text()).toBe(cut);
			const entries = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(entries.map((entry) => entry.phase)).toEqual([
				"stream-cut",
				"stream-cut",
				"stream-cut",
			]);
			expect(entries[0]).toMatchObject({ kind: "openai", willRetry: true });
			expect(entries[2].willRetry).toBe(false);
			expect(JSON.stringify(entries)).not.toContain("Authorization");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("leaves error responses and non-streamed requests alone", async () => {
		let calls = 0;
		const fetch = guardedFetch(async () => {
			calls++;
			return new Response("overloaded", { status: 529 });
		});
		const failed = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: '{"stream":true}',
		});
		expect(failed.status).toBe(529);
		await fetch("https://api.anthropic.com/v1/models/claude-opus-5-5");
		expect(calls).toBe(2);
	});
});

describe("ATIF trajectory", () => {
	const billing = modelBilling({ harness: "api", modelId: "claude-opus-5-5" });
	const at = "2026-10-18T00:00:00.000Z";
	const usage = (input: number, output: number) => ({
		inputTokens: input,
		outputTokens: output,
		uncachedInputTokens: input,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
	const timed = (events: TimedEvent["event"][]): TimedEvent[] =>
		events.map((event) => ({ at, event }));

	it("drops retracted output, keeps freeform tool input and records compaction as its own step", () => {
		const trajectory = atifTrajectory({
			sessionId: "s",
			agent: { name: "ytimesy", version: "test" },
			modelName: "claude-opus-5-5",
			billing,
			systemPrompt: "system",
			instruction: "task",
			startedAt: at,
			events: timed([
				{ type: "text-delta", id: "dropped", text: "partial" },
				{ type: "retract", ids: ["dropped"] },
				{ type: "reasoning-delta", id: "r", text: "thinking" },
				{ type: "text-delta", id: "t", text: "Patching." },
				{
					type: "tool-call",
					id: "p1",
					name: "apply_patch",
					input: "*** Begin Patch",
				},
				{ type: "usage", usage: usage(100, 10) },
				{
					type: "tool-result",
					id: "p1",
					name: "apply_patch",
					output: { ok: true },
				},
				{ type: "context", compacting: true },
				{ type: "usage", usage: usage(150, 20) },
				{ type: "context", compacting: false },
				{ type: "text-delta", id: "f", text: "Done." },
				{ type: "usage", usage: usage(210, 25) },
			]),
		});
		const agentSteps = trajectory.steps.filter(
			(step) => step.source === "agent",
		);
		expect(agentSteps).toHaveLength(3);
		expect(agentSteps[0]).toMatchObject({
			message: "Patching.",
			reasoning_content: "thinking",
			tool_calls: [
				{
					tool_call_id: "p1",
					function_name: "apply_patch",
					arguments: { input: "*** Begin Patch" },
				},
			],
			observation: {
				results: [{ source_call_id: "p1", content: '{"ok":true}' }],
			},
			metrics: { prompt_tokens: 100, completion_tokens: 10 },
		});
		expect(agentSteps[1]).toMatchObject({
			message: "[context compaction]",
			extra: { kind: "compaction" },
			metrics: { prompt_tokens: 50, completion_tokens: 10 },
		});
		expect(agentSteps[2]).toMatchObject({
			message: "Done.",
			metrics: { prompt_tokens: 60, completion_tokens: 5 },
		});
		expect(trajectory.final_metrics).toMatchObject({
			total_prompt_tokens: 210,
			total_completion_tokens: 25,
			total_steps: 5,
		});
		expect(JSON.stringify(trajectory)).not.toContain("partial");
	});
});

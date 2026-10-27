import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atifTrajectory, type TimedEvent } from "../evals/harbor_v2/atif";
import { harborBridgeConfig } from "../evals/harbor_v2/config";
import { jobRuns } from "../evals/harbor_v2/efficiency";
import {
	harborMachines,
	WRITE_CHUNK_CHARS,
} from "../evals/harbor_v2/harbor-machines";
import {
	committedUsd,
	ledgerSummary,
	reserveTrial,
	SpendCapReached,
	settleTrial,
	trialSpendGuard,
} from "../evals/harbor_v2/spend";
import {
	DegenerateOutput,
	guardedFetch,
	requestBodyEffort,
	streamKind,
	terminalEvent,
	whitespaceRun,
} from "../evals/harbor_v2/transport-guard";
import { harborTurnId, isImageToolResult } from "../evals/harbor_v2/trial";
import { modelBilling, usageCostUsd } from "../src/domain/model-pricing";
import { commandScopeRoot } from "../src/server/services/api-command-scope";

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
			harborBridgeConfig({ YTIMESY_HARBOR_ROUTE: "vertex" }),
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
		).toThrow(/refuses subagents=on: several writers/);
	});

	it("passes codeMode=primary and a checker model on the subscription route", () => {
		const config = harborBridgeConfig({
			YTIMESY_HARBOR_ROUTE: "codex-subscription",
			YTIMESY_HARBOR_APPROVED: "codex-subscription",
			YTIMESY_HARBOR_EFFORT: "high",
			YTIMESY_HARBOR_VARIANT:
				"review=on,codeMode=primary,roleModels.checker=codex:gpt-6-luna",
		});
		expect(config.variant).toMatchObject({
			review: "on",
			codeMode: "primary",
			roleModels: { checker: { model: "codex:gpt-6-luna" } },
		});
		expect(config.checker).toMatchObject({
			modelId: "gpt-6-luna",
			effort: "high",
			billing: { kind: "plan" },
		});
		expect(config.checker?.billing.price).not.toBeNull();
		expect(
			harborBridgeConfig({
				YTIMESY_HARBOR_ROUTE: "codex-subscription",
				YTIMESY_HARBOR_APPROVED: "codex-subscription",
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=gpt-6-luna@low",
			}).checker,
		).toMatchObject({ modelId: "gpt-6-luna", effort: "low" });
		// No entry: the checker runs on the builder's model.
		expect(harborBridgeConfig(capped).checker).toBeNull();
	});

	it("refuses checker models the trial's route cannot serve, and other roles", () => {
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=codex:gpt-6-luna",
			}),
		).toThrow(/needs YTIMESY_HARBOR_ROUTE=codex-subscription/);
		expect(() =>
			harborBridgeConfig({
				YTIMESY_HARBOR_ROUTE: "codex-subscription",
				YTIMESY_HARBOR_APPROVED: "codex-subscription",
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=api:gpt-6-luna",
			}),
		).toThrow(/needs an API route/);
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=api/conn/gpt-6-luna",
			}),
		).toThrow(/stored connection/);
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=claude-opus-9-9",
			}),
		).toThrow(/roleModels\.checker's claude-opus-9-9/);
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "roleModels.researcher=claude-sonnet-5-5",
			}),
		).toThrow(/does not implement roleModels\.researcher/);
		// lead=fusion's roles, checkerMode=pair and rigor run in the bridge.
		const fusion = harborBridgeConfig({
			...capped,
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,review=on,checkerMode=pair,rigor=on,codeMode=primary,roleModels.writer=claude-sonnet-5-5,roleModels.checker=claude-sonnet-5-5,roleModels.checkerWorker=claude-sonnet-5-5,roleModels.classifier=claude-sonnet-5-5@low,roleModels.writerEscalation=claude-opus-5-5",
		});
		expect(Object.keys(fusion.roles).sort()).toEqual([
			"checker",
			"checkerWorker",
			"classifier",
			"writer",
			"writerEscalation",
		]);
		expect(fusion.roles.classifier?.effort).toBe("low");
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "checkerMode=pair",
			}),
		).toThrow(/set review=on/);
		for (const subagents of ["on", "force"])
			expect(() =>
				harborBridgeConfig({
					...capped,
					YTIMESY_HARBOR_VARIANT: `subagents=${subagents},lead=fusion`,
				}),
			).toThrow(/several writers at once.*use helpers=on/);
		expect(
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "codeMode=primary,plan=on,helpers=on,fetch=on",
			}).variant,
		).toMatchObject({
			codeMode: "primary",
			plan: "on",
			helpers: "on",
			fetch: "on",
		});
		expect(
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "codeMode=on,helpers=write",
			}).variant.helpers,
		).toBe("write");
		expect(() =>
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "helpers=many",
			}),
		).toThrow();
		expect(harborBridgeConfig(capped).variant).toMatchObject({
			plan: "off",
			helpers: "off",
			fetch: "off",
		});
		expect(
			harborBridgeConfig({
				...capped,
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=claude-sonnet-5-5",
			}).checker?.billing.price,
		).toMatchObject({ input: expect.any(Number) });
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
			capUsd: 1,
			requestLimit: 10,
			parts: () => [{ usage, billing }],
		});
		guard.beforeRequest();
		usage = { ...usage, inputTokens: 250_000, uncachedInputTokens: 250_000 };
		expect(() => guard.beforeRequest()).toThrow(SpendCapReached);
		expect(guard.stopReason()).toMatch(/\$1\.0000 of \$1/);
		expect(guard.requests()).toBe(1);
	});

	it("enforces the request limit", () => {
		const guard = trialSpendGuard({
			capUsd: null,
			requestLimit: 2,
			parts: () => [],
		});
		guard.beforeRequest();
		guard.beforeRequest();
		expect(() => guard.beforeRequest()).toThrow(/request limit/);
	});

	it("prices each model run at its own model (a cheaper checker counts less)", () => {
		const tokens = {
			inputTokens: 100_000,
			outputTokens: 0,
			uncachedInputTokens: 100_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const luna = modelBilling({ harness: "api", modelId: "gpt-6-luna" });
		const guard = trialSpendGuard({
			capUsd: null,
			requestLimit: 10,
			parts: () => [
				{ usage: tokens, billing },
				{ usage: tokens, billing: luna },
			],
		});
		expect(guard.spentUsd()).toBeCloseTo(
			(usageCostUsd(tokens, billing) ?? 0) + (usageCostUsd(tokens, luna) ?? 0),
			6,
		);
		expect(usageCostUsd(tokens, luna)).not.toBe(usageCostUsd(tokens, billing));
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
				body: '{"stream":true,"input":[],"reasoning":{"effort":"max"}}',
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
			expect(entries[0]).toMatchObject({
				kind: "openai",
				effort: "max",
				willRetry: true,
			});
			expect(entries[2].willRetry).toBe(false);
			expect(JSON.stringify(entries)).not.toContain("Authorization");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reads the reasoning effort a request body names, per provider", () => {
		expect(
			requestBodyEffort('{"stream":true,"reasoning":{"effort":"high"}}'),
		).toBe("high");
		expect(
			requestBodyEffort('{"stream":true,"output_config":{"effort":"max"}}'),
		).toBe("max");
		expect(requestBodyEffort('{"stream":true}')).toBeNull();
		expect(requestBodyEffort("not json")).toBeNull();
		expect(requestBodyEffort(null)).toBeNull();
	});

	it("counts a whitespace run across deltas, escaped newlines in tool-call arguments included", () => {
		const run = whitespaceRun();
		expect(run('{"code":"const x = 1;')).toBe(0);
		expect(run(" \\n  \\n")).toBe(7);
		expect(run("\\t\\t ")).toBe(12);
		expect(run("return x;  ")).toBe(2);
	});

	it("cuts a response whose tool-call arguments degenerate into whitespace, and resends it", async () => {
		// atrx-vep-crispr (s3): Luna streamed 64K tokens of blank lines inside
		// one run_code call, 15-17 MB over 6-8.5 minutes, until max_output_tokens.
		const directory = await mkdtemp(join(tmpdir(), "harbor-guard-"));
		try {
			const log = join(directory, "transport.log");
			const delta = (text: string) =>
				JSON.stringify({
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: text,
				});
			const blank = sse([
				'{"type":"response.created"}',
				delta('{"code":"const r = await tools.bash({command:`ls'),
				...Array.from({ length: 400 }, () => delta(" \\n  \\n")),
				'{"type":"response.incomplete","response":{"status":"incomplete"}}',
			]);
			const complete = sse([
				'{"type":"response.created"}',
				delta('{"code":"return 1;"}'),
				'{"type":"response.completed","response":{"status":"completed"}}',
			]);
			const bodies = [blank, complete];
			let calls = 0;
			const fetch = guardedFetch(
				async () => new Response(streamOf(bodies[calls++]), { status: 200 }),
				{ delayMs: () => 0, logPath: log, degenerateRunChars: 1000 },
			);
			const response = await fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: '{"stream":true,"input":[]}',
			});
			expect(calls).toBe(2);
			expect(await response.text()).toBe(complete);
			const entries = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(entries.map((entry) => entry.phase)).toEqual([
				"degenerate",
				"stream",
			]);
			expect(entries[0].errors[0].message).toContain("unbroken whitespace");

			// Every attempt degenerate: the loop gets an error it resamples
			// as an interrupted stream ("terminated").
			const always = guardedFetch(
				async () => new Response(streamOf(blank), { status: 200 }),
				{ delayMs: () => 0, degenerateRunChars: 1000, maxAttempts: 2 },
			);
			const last = await always("https://api.openai.com/v1/responses", {
				method: "POST",
				body: '{"stream":true,"input":[]}',
			});
			const error = await last.text().catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(DegenerateOutput);
			expect(String(error)).toMatch(/\bterminated\b/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("leaves a response with ordinary whitespace in its output alone", async () => {
		const body = sse([
			JSON.stringify({
				type: "response.output_text.delta",
				delta: `${"text\n\n    ".repeat(500)}`,
			}),
			'{"type":"response.completed","response":{"status":"completed"}}',
		]);
		let calls = 0;
		const fetch = guardedFetch(
			async () => {
				calls++;
				return new Response(streamOf(body), { status: 200 });
			},
			{ delayMs: () => 0, degenerateRunChars: 1000 },
		);
		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			body: '{"stream":true}',
		});
		expect(await response.text()).toBe(body);
		expect(calls).toBe(1);
	});

	it("hands back an error response once the throttle window is spent, and leaves non-streamed requests alone", async () => {
		let calls = 0;
		const fetch = guardedFetch(
			async () => {
				calls++;
				return new Response("overloaded", { status: 529 });
			},
			{ throttleWindowMs: 0, throttleDelayMs: () => 0 },
		);
		const failed = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			body: '{"stream":true}',
		});
		expect(failed.status).toBe(529);
		await fetch("https://api.anthropic.com/v1/models/claude-opus-5-5");
		expect(calls).toBe(2);
	});
});

describe("harbor machines", () => {
	it("writes a file larger than one command argument may be, in pieces", async () => {
		// Linux caps one argument at 128 KiB; a 423 KB report failed every edit.
		const directory = await mkdtemp(join(tmpdir(), "harbor-machines-"));
		try {
			const { execFile } = await import("node:child_process");
			const commands: string[] = [];
			const machines = harborMachines(async (command) => {
				commands.push(command);
				if (command.length > 131_072)
					return { id: 0, exitCode: 126, stderr: "Argument list too long" };
				return await new Promise((resolve) =>
					execFile("/bin/sh", ["-c", command], (error, stdout, stderr) =>
						resolve({
							id: 0,
							exitCode: error ? Number(error.code) || 1 : 0,
							stdout,
							stderr,
						}),
					),
				);
			});
			const path = join(directory, "out", "report.json");
			const contents = `{"rows":[${Array.from({ length: 9000 }, (_, i) => `"row ${i} ${"é".repeat(20)}"`).join(",")}]}`;
			expect(Buffer.byteLength(contents)).toBeGreaterThan(400_000);
			await machines.writeTextFile("vm" as never, path, contents);
			expect(await readFile(path, "utf8")).toBe(contents);
			expect(commands.length).toBeGreaterThan(2);
			expect(
				Math.max(...commands.map((command) => command.length)),
			).toBeLessThan(WRITE_CHUNK_CHARS + 1000);
			// A small file is still one command.
			commands.length = 0;
			await machines.writeTextFile("vm" as never, path, "small");
			expect(await readFile(path, "utf8")).toBe("small");
			expect(commands).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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

describe("job efficiency", () => {
	let directory: string;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("joins each trial's cost block with its verifier reward and skips trials without one", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-efficiency-"));
		const row = {
			role: "builder",
			model: "gpt-6.1-sol",
			agents: 1,
			requests: 4,
			inputTokens: 1000,
			outputTokens: 100,
			cacheReadTokens: 800,
			costUsd: 0.01,
			estimated: true,
		};
		const trial = async (
			name: string,
			reward: number | null,
			trace: boolean,
		) => {
			await mkdir(join(directory, name, "agent"), { recursive: true });
			await writeFile(
				join(directory, name, "result.json"),
				JSON.stringify({ verifier_result: { rewards: { reward } } }),
			);
			if (trace)
				await writeFile(
					join(directory, name, "agent", "ytimesy-trace.json"),
					JSON.stringify({
						efficiency: { secondsPerTask: 60, modelRows: [row] },
					}),
				);
		};
		await trial("a__1", 1, true);
		await trial("b__2", 0, true);
		await trial("c__3", 1, false);
		const runs = await jobRuns(directory);
		expect(runs.map((run) => run.solved).sort()).toEqual([false, true]);
		expect(runs[0]).toMatchObject({ seconds: 60, models: [row] });
	});
});

describe("harbor turn ids", () => {
	it("gives Harbor trial and child ids a turn id the command runner accepts", () => {
		// Harbor ids carry underscores and child ids a dot; raw, every bash
		// call of the lead and its sidekick failed with "Invalid command scope".
		for (const id of [
			"session-window-debug__MVgXW8D",
			"session-window-debug__MVgXW8D.1",
			"harbor-checker-1",
			`${"x".repeat(90)}__y.2`,
		])
			expect(() => commandScopeRoot(harborTurnId(id))).not.toThrow();
		expect(harborTurnId("harbor-checker-1")).toBe("harbor-checker-1-turn");
		expect(harborTurnId("a__b.1")).not.toBe(harborTurnId("a__b"));
		// A child's rounds: one scope each, the round kept for a long id too.
		const long = `${"x".repeat(90)}__y.2`;
		expect(harborTurnId(long, 2)).not.toBe(harborTurnId(long, 3));
		expect(() => commandScopeRoot(harborTurnId(long, 12))).not.toThrow();
		expect(harborTurnId("t.1", 2)).toBe("t-1-r2-turn");
	});
});

describe("isImageToolResult", () => {
	it("recognizes the read tool's image output only", () => {
		expect(
			isImageToolResult({
				type: "tool-result",
				name: "read",
				output: { image: "image/png", base64: "iVBOR" },
			}),
		).toBe(true);
		expect(
			isImageToolResult({ type: "tool-result", name: "read", output: "text" }),
		).toBe(false);
		expect(
			isImageToolResult({
				type: "tool-call",
				output: { image: "x", base64: "y" },
			}),
		).toBe(false);
	});
});

describe("transport guard throttling", () => {
	const sse = () =>
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(
						new TextEncoder().encode(
							'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
						),
					);
					c.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	const body = JSON.stringify({ model: "m", stream: true, input: [] });
	it("waits out 429s and 5xx before output, then returns the stream", async () => {
		const statuses = [429, 503, 200];
		let calls = 0;
		const fetch = guardedFetch(
			async () => {
				const s = statuses[calls++];
				return s === 200 ? sse() : new Response("slow down", { status: s });
			},
			{ throttleDelayMs: () => 0 },
		);
		const res = await fetch("https://x.test/v1/responses", {
			method: "POST",
			body,
		});
		expect(res.status).toBe(200);
		expect(calls).toBe(3);
	});
	it("hands back the throttled response once the window is spent", async () => {
		let calls = 0;
		const fetch = guardedFetch(
			async () => {
				calls++;
				return new Response("slow down", { status: 429 });
			},
			{ throttleWindowMs: 0, throttleDelayMs: () => 1 },
		);
		const res = await fetch("https://x.test/v1/responses", {
			method: "POST",
			body,
		});
		expect(res.status).toBe(429);
		expect(calls).toBe(1);
	});
});

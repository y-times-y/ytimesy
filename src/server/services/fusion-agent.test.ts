import type { ModelMessage } from "ai";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runFusionAgent, type SidekickState } from "./fusion-agent";
import type { ModelAgentRuntime } from "./model-agent-loop";

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const finish = (reason: "stop" | "tool-calls" = "stop") => ({
	type: "finish" as const,
	usage,
	finishReason: { unified: reason, raw: reason },
});
const call = (id: string, toolName: string, input: unknown) => [
	{
		type: "tool-call" as const,
		toolCallId: id,
		toolName,
		input: JSON.stringify(input),
	},
	finish("tool-calls"),
];
const say = (text: string) => [
	{ type: "text-start" as const, id: text },
	{ type: "text-delta" as const, id: text, delta: text },
	{ type: "text-end" as const, id: text },
	finish(),
];
/** A model that plays a fixed script, one response per request. */
function scripted(responses: unknown[][]) {
	let index = 0;
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: responses[Math.min(index++, responses.length - 1)] as never,
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
		doGenerate: async () => ({
			content: [
				{ type: "text", text: '{"decision":"continue","reason":"fine"}' },
			],
			finishReason: { unified: "stop", raw: "stop" },
			usage,
			warnings: [],
		}),
	});
	return { model, requests: () => index };
}

function harness(scripts: {
	lead: unknown[][];
	sidekick: unknown[][];
	classifier?: string;
	slowCommand?: number;
	sidekickContextWindow?: number;
	bigOutput?: boolean;
	classifyEvery?: number;
}) {
	const lead = scripted(scripts.lead);
	const sidekick = scripted(scripts.sidekick);
	const upgraded = scripted([
		say("Upgraded sidekick: finished after the switch."),
	]);
	const classifier = new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [
				{
					type: "text",
					text: scripts.classifier ?? '{"decision":"continue","reason":"ok"}',
				},
			],
			finishReason: { unified: "stop", raw: "stop" },
			usage,
			warnings: [],
		}),
	});
	const commands: string[] = [];
	const workspaceTools = {
		execute_command: tool({
			inputSchema: z.object({ command: z.string() }),
			execute: async ({ command }) => {
				commands.push(command);
				if (scripts.slowCommand)
					await new Promise((done) => setTimeout(done, scripts.slowCommand));
				return {
					status: 0,
					stdout: scripts.bigOutput ? "x".repeat(150_000) : `ran ${command}`,
				};
			},
		}),
	};
	const runtimeFor = (
		model: MockLanguageModelV4,
		contextWindow?: number,
	): ModelAgentRuntime => ({
		model,
		...(contextWindow ? { contextWindow, autoCompactTokenLimit: 20_000 } : {}),
	});
	const saved = vi.fn(async () => {});
	return {
		lead,
		sidekick,
		upgraded,
		commands,
		saved,
		run: (state: SidekickState = { modelId: "gpt-6.1-sol", messages: [] }) =>
			runFusionAgent({
				lead: {
					userId: "alice",
					modelId: "gpt-6-astra",
					instructions: "Lead",
					messages: [{ role: "user", content: "Fix the bug" }],
					tools: {},
					signal: new AbortController().signal,
					onEvent: async () => {},
					onStep: async () => {},
				},
				leadRuntime: runtimeFor(lead.model),
				workspaceTools,
				config: {
					sidekickModelId: "gpt-6.1-sol",
					upgradeModelId: "gpt-6-astra",
					classifierModelId: "gpt-5.6-luna",
					classifyEverySteps: scripts.classifyEvery ?? 1,
				},
				makeRuntime: async (modelId) =>
					runtimeFor(
						modelId === "gpt-5.6-luna"
							? classifier
							: modelId === "gpt-6-astra"
								? upgraded.model
								: sidekick.model,
						modelId === "gpt-6.1-sol"
							? scripts.sidekickContextWindow
							: undefined,
					),
				sidekick: state,
				saveSidekick: saved,
				onSidekickEvent: async () => {},
			}),
	};
}

it("delegates with a brief, monitors, receives the sidekick's report, and answers the user", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Fix flush visibility",
				constraints: ["Keep compaction"],
				success_criteria: ["make test passes"],
			}),
			call("x", "execute_command", { command: "git diff" }),
			call("w", "wait_for_sidekick", { seconds: 5 }),
			say("Reviewed: fixed and verified."),
		],
		sidekick: [
			call("s", "execute_command", { command: "make test" }),
			say("Report: fixed flush; make test passed."),
		],
		slowCommand: 50,
	});
	const messages = await fusion.run();
	const transcript = JSON.stringify(messages);
	// The lead's command was refused while the sidekick owned the workspace.
	expect(transcript).toContain("The sidekick is working in the workspace");
	expect(transcript).toContain("Report: fixed flush; make test passed.");
	expect(transcript).toContain("Reviewed: fixed and verified.");
	expect(fusion.commands).toEqual(["make test"]);
	expect(fusion.saved).toHaveBeenCalled();
});

it("hands the task back to the lead when the classifier says the sidekick is out of its depth", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Hard task",
				constraints: [],
				success_criteria: ["works"],
			}),
			call("w", "wait_for_sidekick", { seconds: 5 }),
			say("I took over."),
		],
		sidekick: [
			call("s", "execute_command", { command: "try" }),
			call("s2", "execute_command", { command: "try again" }),
			say("never"),
		],
		classifier: '{"decision":"return_to_lead","reason":"repeating failures"}',
	});
	const transcript = JSON.stringify(await fusion.run());
	expect(transcript).toContain("handed the task back: repeating failures");
	expect(transcript).toContain("I took over.");
});

it("lets the lead take control back from a running sidekick", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Long task",
				constraints: [],
				success_criteria: ["done"],
			}),
			call("t", "take_control", { reason: "faster to finish myself" }),
			call("x", "execute_command", { command: "make test" }),
			say("Finished myself."),
		],
		sidekick: [
			call("s", "execute_command", { command: "slow" }),
			say("late report"),
		],
		slowCommand: 200,
	});
	const transcript = JSON.stringify(await fusion.run());
	expect(transcript).toContain("lead in control");
	expect(transcript).toContain("Finished myself.");
	expect(fusion.commands).toContain("make test");
});

it("switches the sidekick to the upgrade model at compaction when the classifier asks", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Big task",
				constraints: [],
				success_criteria: ["done"],
			}),
			call("w", "wait_for_sidekick", { seconds: 5 }),
			say("Reviewed the upgraded sidekick's work."),
		],
		sidekick: [
			call("s1", "execute_command", { command: "cat big.log" }),
			call("s2", "execute_command", { command: "cat bigger.log" }),
			say("weak sidekick never gets here"),
		],
		classifier: '{"decision":"switch_model","reason":"needs a stronger model"}',
		classifyEvery: 100,
		sidekickContextWindow: 200_000,
		bigOutput: true,
	});
	const state = {
		modelId: "gpt-6.1-sol",
		messages: Array.from({ length: 6 }, (_, turn) => [
			{ role: "user" as const, content: `${turn} ${"x".repeat(14_000)}` },
			{ role: "assistant" as const, content: `Earlier work ${turn}` },
		]).flat() as ModelMessage[],
	};
	const transcript = JSON.stringify(await fusion.run(state));
	expect(transcript).toContain("Upgraded sidekick: finished after the switch.");
	expect(state.modelId).toBe("gpt-6-astra");
});

it("shows the lead the sidekick's progress and delivers feedback while it works", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Fix it",
				constraints: [],
				success_criteria: ["tests pass"],
			}),
			call("w1", "wait_for_sidekick", { seconds: 1 }),
			call("m", "message_sidekick", {
				feedback: "Focus on flush, not compaction.",
			}),
			call("w2", "wait_for_sidekick", { seconds: 10 }),
			say("Reviewed."),
		],
		sidekick: [
			call("s1", "execute_command", { command: "make repro" }),
			call("s2", "execute_command", { command: "make test" }),
			say("Report: flush fixed; make test passed."),
		],
		slowCommand: 1500,
	});
	const transcript = JSON.stringify(await fusion.run());
	expect(transcript).toContain('"status":"running"');
	expect(transcript).toContain("make repro");
	expect(transcript).toContain('"queued":true');
	expect(transcript).toContain("Report: flush fixed; make test passed.");
	// The feedback reached the sidekick's own context mid-run.
	const prompts = JSON.stringify(
		fusion.sidekick.model.doStreamCalls.map((request) => request.prompt),
	);
	expect(prompts).toContain("Focus on flush, not compaction.");
});

it("hands back a sidekick that passes its step budget, with what it found", async () => {
	const fusion = harness({
		lead: [
			call("d", "delegate_to_sidekick", {
				task: "Explore",
				constraints: [],
				success_criteria: ["a report"],
				step_budget: 5,
			}),
			call("w", "wait_for_sidekick", { seconds: 10 }),
			say("Taking over with its notes."),
		],
		sidekick: Array.from({ length: 30 }, (_, step) =>
			call(`s${step}`, "execute_command", { command: `probe ${step}` }),
		),
	});
	const transcript = JSON.stringify(await fusion.run());
	expect(transcript).toContain("passed its 5-step budget without reporting");
	expect(transcript).toContain("Its last actions");
	expect(fusion.commands.length).toBeLessThanOrEqual(12);
	const prompts = JSON.stringify(
		fusion.sidekick.model.doStreamCalls.map((request) => request.prompt),
	);
	expect(prompts).toContain("reached your 5-step budget");
});

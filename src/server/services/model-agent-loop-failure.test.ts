import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { failoverReason } from "#/domain/model-failover-reason";
import {
	continuedTurnHistory,
	UNANSWERED_TOOL_CALL,
} from "#/domain/runtime-handoff";
import {
	type ModelAgentInput,
	runModelAgent,
	runModelAgentStep,
} from "./model-agent-loop";

function input(onAttemptFailed: ModelAgentInput["onAttemptFailed"]) {
	return {
		userId: "owner",
		modelId: "model",
		instructions: "Fix it",
		messages: [{ role: "user" as const, content: "Fix it" }],
		toolSurface: "implementation" as const,
		tools: {},
		signal: new AbortController().signal,
		onEvent: vi.fn(async () => {}),
		onStep: vi.fn(async () => {}),
		onAttemptFailed,
	};
}

it("reports the clean history when a provider refuses the step before any output", async () => {
	const failed = vi.fn();
	const model = new MockLanguageModelV4({
		doStream: async () => {
			throw new APICallError({
				message: "Service Unavailable",
				url: "https://provider.invalid/v1/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: false,
			});
		},
	});
	const run = input(failed);
	const error = await runModelAgentStep(run, { model }).catch(
		(cause: unknown) => cause,
	);
	expect(failoverReason(error)).toBe("outage");
	expect(failed).toHaveBeenCalledWith({
		committed: run.messages,
		droppedStepSaved: false,
		uncommittedIds: [],
	});
});

it("reports a failed stream's partial output so a fallback can retract it", async () => {
	const failed = vi.fn();
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{ type: "text-start", id: "t" },
					{ type: "text-delta", id: "t", delta: "Now I" },
					{
						type: "error",
						error: { type: "overloaded_error", message: "Overloaded" },
					},
				],
			}),
		}),
	});
	const error = await runModelAgentStep(input(failed), { model }).catch(
		(cause: unknown) => cause,
	);
	expect(failoverReason(error)).toBe("overloaded");
	expect(failed).toHaveBeenCalledTimes(1);
	expect(failed.mock.calls[0][0].uncommittedIds).toEqual(["t"]);
});

it("reports a stopped step's started tool call, which no checkpoint saved", async () => {
	const failed = vi.fn();
	const stop = new AbortController();
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "run",
						input: '{"command":"sleep 60; echo marker-one"}',
					},
					{
						type: "finish",
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
						usage: {
							inputTokens: {
								total: 3,
								noCache: 3,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 2, text: 2, reasoning: 0 },
						},
					},
				],
			}),
		}),
	});
	const started = vi.fn();
	const run = {
		...input(failed),
		signal: stop.signal,
		tools: {
			run: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: (_input, { abortSignal }) =>
					new Promise((_resolve, reject) => {
						started();
						abortSignal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					}),
			}),
		},
	};
	const pending = runModelAgentStep(run, { model }).catch(
		(cause: unknown) => cause,
	);
	await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
	stop.abort();
	await pending;
	expect(run.onStep).not.toHaveBeenCalled();
	expect(failed).toHaveBeenCalledTimes(1);
	const call = {
		type: "tool-call",
		toolCallId: "call-1",
		toolName: "run",
		input: { command: "sleep 60; echo marker-one" },
	};
	const { inFlight } = failed.mock.calls[0][0];
	expect(inFlight).toEqual([
		...run.messages,
		{ role: "assistant", content: [call] },
	]);
	// The next turn sees the call it made, answered with the stop stand-in.
	expect(
		continuedTurnHistory(
			{
				messages: inFlight,
				modelId: "model",
				connectionRevision: "revision",
				state: "cancelled",
				failedOver: false,
			},
			{ modelId: "model", connectionRevision: "revision" },
		).slice(1),
	).toEqual([
		{ role: "assistant", content: [call] },
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "run",
					output: { type: "error-text", value: UNANSWERED_TOOL_CALL.stopped },
				},
			],
		},
	]);
});

it("reports no in-flight calls once the step that made them finished", async () => {
	const failed = vi.fn();
	let streams = 0;
	const model = new MockLanguageModelV4({
		doStream: async () => {
			if (streams++)
				throw new APICallError({
					message: "Service Unavailable",
					url: "https://provider.invalid/v1/responses",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: false,
				});
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "run",
							input: '{"command":"true"}',
						},
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage: {
								inputTokens: {
									total: 3,
									noCache: 3,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 2, text: 2, reasoning: 0 },
							},
						},
					],
				}),
			};
		},
	});
	const run = {
		...input(failed),
		tools: {
			run: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: async () => "ok",
			}),
		},
	};
	await runModelAgent(run, { model }).catch((cause: unknown) => cause);
	expect(run.onStep).toHaveBeenCalled();
	expect(failed).toHaveBeenCalledTimes(1);
	expect(failed.mock.calls[0][0].inFlight).toBeUndefined();
});

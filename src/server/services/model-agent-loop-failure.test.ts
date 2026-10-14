import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { failoverReason } from "#/domain/model-failover-reason";
import { type ModelAgentInput, runModelAgentStep } from "./model-agent-loop";

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

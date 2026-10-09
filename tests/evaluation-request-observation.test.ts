import { APICallError } from "ai";
import { expect, it, vi } from "vitest";
import {
	type EvaluationRequestObservation,
	observeEvaluationRequest,
} from "../benchmarks/evaluation/request-observation";

it("records a stream opening without consuming it or claiming completed usage", async () => {
	const response = {
		stream: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
	};
	const record = vi.fn(async () => {});
	expect(
		await observeEvaluationRequest(
			{ request: 1, method: "doStream" },
			async () => response,
			record,
		),
	).toBe(response);
	expect(response.stream.locked).toBe(false);
	expect(record).toHaveBeenCalledWith(
		expect.objectContaining({ request: 1, outcome: "response_returned" }),
	);
});

it("retains sanitized failed starts and never retries them itself", async () => {
	const attempts: EvaluationRequestObservation[] = [];
	const failure = new APICallError({
		message: "PRIVATE prompt and credential",
		url: "https://example.com/PRIVATE",
		requestBodyValues: { secret: "PRIVATE" },
		statusCode: 503,
		responseBody: "PRIVATE",
	});
	const request = vi.fn(async () => {
		throw failure;
	});
	const record = async (observation: EvaluationRequestObservation) => {
		attempts.push(observation);
	};
	await expect(
		observeEvaluationRequest(
			{ request: 1, method: "doStream" },
			request,
			record,
		),
	).rejects.toBe(failure);
	expect(request).toHaveBeenCalledOnce();
	await observeEvaluationRequest(
		{ request: 2, method: "doStream" },
		async () => "opened",
		record,
	);
	expect(attempts).toMatchObject([
		{ outcome: "start_failed", failure: { httpStatus: 503 } },
		{ outcome: "response_returned" },
	]);
	expect(JSON.stringify(attempts)).not.toContain("PRIVATE");
	expect(attempts.every((attempt) => attempt.durationMs >= 0)).toBe(true);
});

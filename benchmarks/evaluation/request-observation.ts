import { apiModelFailureClassification } from "../../src/domain/api-turn-failure";

export type EvaluationRequestObservation = {
	request: number;
	method: "doStream" | "doGenerate";
	durationMs: number;
} & (
	| { outcome: "response_returned" }
	| {
			outcome: "start_failed";
			failure: ReturnType<typeof apiModelFailureClassification>;
	  }
);

/** A returned stream is not a completed inference; failed starts remain visible across SDK retries. */
export async function observeEvaluationRequest<T>(
	identity: Pick<EvaluationRequestObservation, "request" | "method">,
	request: () => Promise<T>,
	record: (observation: EvaluationRequestObservation) => Promise<void>,
): Promise<T> {
	const started = performance.now();
	let response: T;
	try {
		response = await request();
	} catch (error) {
		await record({
			...identity,
			outcome: "start_failed",
			durationMs: Math.max(0, performance.now() - started),
			failure: apiModelFailureClassification(error),
		});
		throw error;
	}
	await record({
		...identity,
		outcome: "response_returned",
		durationMs: Math.max(0, performance.now() - started),
	});
	return response;
}

import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { apiTurnFailureMessage } from "./api-turn-failure";
import {
	isModelUnavailableFailureMessage,
	MODEL_UNAVAILABLE_FAILURE,
	modelUnavailableDetail,
} from "./codex-model-unavailable";

function failure(statusCode: number, body: unknown) {
	return new APICallError({
		message: "Bad Request",
		url: "https://example.test/responses",
		requestBodyValues: {},
		statusCode,
		responseBody: JSON.stringify(body),
		data: body,
	});
}

describe("a model the account is not offered", () => {
	it("is worded the same for the relay's code and ChatGPT's own words", () => {
		for (const error of [
			failure(400, { error: { code: "model_not_found", message: "x" } }),
			failure(400, {
				detail:
					"The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
			}),
			failure(404, { error: { message: "The model `gpt-9` does not exist" } }),
		])
			expect(apiTurnFailureMessage("model", error)).toBe(
				MODEL_UNAVAILABLE_FAILURE,
			);
	});

	it("is recognised from a saved failure message (even with a suffix)", () => {
		expect(isModelUnavailableFailureMessage(MODEL_UNAVAILABLE_FAILURE)).toBe(
			true,
		);
		expect(
			isModelUnavailableFailureMessage(`${MODEL_UNAVAILABLE_FAILURE} More.`),
		).toBe(true);
		expect(isModelUnavailableFailureMessage("Your usage is used up.")).toBe(
			false,
		);
	});

	it("does not read other model complaints as unavailable", () => {
		expect(modelUnavailableDetail("This model does not support tools.")).toBe(
			false,
		);
		expect(modelUnavailableDetail("Unsupported parameter: temperature")).toBe(
			false,
		);
		expect(
			apiTurnFailureMessage(
				"model",
				failure(400, { error: { message: "context length exceeded" } }),
			),
		).not.toBe(MODEL_UNAVAILABLE_FAILURE);
	});
});

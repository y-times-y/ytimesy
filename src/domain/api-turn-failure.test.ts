import { APICallError } from "ai";
import { expect, it } from "vitest";
import {
	apiModelFailureClassification,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	CodexReconnectRequired,
	SafeApiModelFailure,
	SubscriptionMetadataFailure,
} from "./api-turn-failure";

it("preserves safe metadata failure categories in the visible model-stage error", () => {
	for (const reason of [
		"timeout",
		"transport",
		"invalid-response",
		403,
	] as const) {
		const error = new SubscriptionMetadataFailure(reason);
		expect(apiTurnFailureMessage("model", error)).toBe(error.message);
		expect(error.message).toContain("No inference was started");
	}
});

it("logs only recognized failure classifications, never arbitrary error properties", () => {
	expect(
		apiTurnFailureClassification(
			Object.assign(new Error("private query"), { code: "ECONNRESET" }),
		),
	).toEqual({ name: "Error", code: "ECONNRESET" });
	expect(
		apiTurnFailureClassification(
			new DOMException("private host", "TimeoutError"),
		),
	).toEqual({ name: "TimeoutError", code: "unknown" });
	expect(
		apiTurnFailureClassification({
			name: "PRIVATE",
			code: "PRIVATE",
			message: "secret",
		}),
	).toEqual({ name: "unknown", code: "unknown" });
});

it("distinguishes safe failure stages without exposing provider details", () => {
	expect(apiTurnFailureMessage("workspace")).toContain("workspace");
	expect(apiTurnFailureMessage("budget")).toContain("before a model request");
	expect(apiTurnFailureMessage("model")).toContain("No fallback was used");
});

function providerFailure(statusCode: number, data?: unknown) {
	return new APICallError({
		message: "Secret request: sk-fixture-do-not-show",
		url: "https://example.com/v1/chat/completions",
		requestBodyValues: { apiKey: "sk-fixture-do-not-show" },
		responseBody: "sk-fixture-do-not-show",
		statusCode,
		data,
	});
}

it("explains provider age confirmation without blaming the key or exposing raw errors", () => {
	const error = new APICallError({
		message: "Provider rejected request",
		url: "https://openrouter.ai/api/v1/chat/completions",
		requestBodyValues: { apiKey: "sk-private-do-not-show" },
		statusCode: 403,
		responseBody: JSON.stringify({
			error: {
				message:
					"This model requires 18+ age confirmation. sk-private-do-not-show",
			},
		}),
	});
	const message = apiTurnFailureMessage("model", error);
	expect(message).toContain("one-time 18+ age confirmation");
	expect(message).toContain("model selector");
	expect(message).not.toContain("sk-private");
	expect(message).not.toContain("key does not have access");
});

it.each([
	[401, "API key"],
	[402, "insufficient credit"],
	[403, "does not have access"],
	[404, "unavailable"],
	[429, "rate limit"],
	[503, "provider is unavailable"],
])(
	"explains provider HTTP %i without exposing request data",
	(status, reason) => {
		const message = apiTurnFailureMessage("model", providerFailure(status));
		expect(message).toContain(reason);
		expect(message).not.toContain("sk-fixture-do-not-show");
	},
);

it("uses structured provider codes when HTTP 400 is too broad", () => {
	const error = providerFailure(400, {
		error: { code: "context_length_exceeded" },
	});
	expect(apiTurnFailureMessage("model", error)).toContain("context window");
});

it.each([
	"Requests ending with a model turn are not supported.",
	"Assistant prefill is not supported for this model.",
	"Prefilling assistant responses is not supported for this model.",
])(
	"explains unsupported assistant prefill without echoing provider data: %s",
	(reason) => {
		const error = new APICallError({
			message: reason,
			url: "https://example.com/v1/chat/completions",
			requestBodyValues: { apiKey: "sk-private" },
			responseBody: JSON.stringify({
				error: { message: `${reason} sk-private` },
			}),
			statusCode: 400,
		});
		const visible = apiTurnFailureMessage("model", error);
		expect(visible).toContain("conversation-format failure");
		expect(visible).not.toContain("sk-private");
	},
);

it("classifies accepted-request stream failures without leaking payloads", () => {
	const error = providerFailure(200, {
		error: { code: "internal_error", message: "secret" },
	});
	expect(apiModelFailureClassification(error)).toMatchObject({
		httpStatus: 200,
		providerCode: "internal_error",
	});
	expect(apiTurnFailureMessage("model", error)).toContain(
		"response stream failed",
	);
	expect(JSON.stringify(apiModelFailureClassification(error))).not.toContain(
		"secret",
	);
	expect(
		apiModelFailureClassification(
			providerFailure(200, { error: { code: "sk-secret" } }),
		).providerCode,
	).toBe("unknown");
});

it("never stores raw provider text in the safe failure", () => {
	const failure = new SafeApiModelFailure(providerFailure(429));
	expect(failure.message).toContain("rate limit");
	expect(failure.message).not.toContain("sk-fixture-do-not-show");
	expect(apiTurnFailureMessage("model", failure)).toBe(failure.message);
});

it("identifies missing local archive configuration without publishing arbitrary error text", () => {
	expect(
		new SafeApiModelFailure(
			new Error("Private checkpoint storage is not configured."),
		).message,
	).toContain("harness configuration failure");
	expect(
		new SafeApiModelFailure(
			new Error("Private checkpoint storage is not configured. secret"),
		).message,
	).not.toContain("secret");
});

it("distinguishes context and usage budgets", () => {
	expect(
		apiTurnFailureMessage(
			"budget",
			new Error("This conversation exceeds the API context safety limit."),
		),
	).toContain("handoff summary");
	expect(apiTurnFailureMessage("budget", new Error("usage limit"))).toContain(
		"safety limit",
	);
});

it("tells the user to reconnect Codex even when the SDK wraps the refresh failure", () => {
	const wrapped = new Error("Cannot connect to API", {
		cause: new CodexReconnectRequired(),
	});
	expect(apiTurnFailureMessage("model", wrapped)).toContain("reconnect Codex");
	expect(
		apiTurnFailureMessage("model", new CodexReconnectRequired()),
	).toContain("reconnect Codex");
});

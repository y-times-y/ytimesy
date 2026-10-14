import { APICallError } from "ai";
import { expect, it } from "vitest";
import {
	apiModelFailureClassification,
	apiModelFailureMessage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	CodexReconnectRequired,
	MachineUsageLimitReached,
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

it("retains bounded transport cause categories through safe wrapping", () => {
	const socket = Object.assign(new Error("private socket headers"), {
		code: "UND_ERR_SOCKET",
	});
	const error = new APICallError({
		message: "private response",
		url: "https://private.example",
		requestBodyValues: { token: "sk-private" },
		statusCode: 200,
		cause: new TypeError("private fetch", { cause: socket }),
	});
	const classification = apiModelFailureClassification(error);
	expect(classification.causes).toEqual([
		{ name: "TypeError", code: "unknown" },
		{ name: "Error", code: "UND_ERR_SOCKET" },
	]);
	expect(apiModelFailureClassification(new SafeApiModelFailure(error))).toEqual(
		classification,
	);
	expect(JSON.stringify(classification)).not.toContain("private");
});

it("bounds cyclic cause chains and excludes arbitrary codes", () => {
	const error = Object.assign(new Error("secret"), {
		code: "secret",
		cause: undefined as unknown,
	});
	error.cause = error;
	const classification = apiModelFailureClassification(error);
	expect(classification.causes).toEqual([{ name: "Error", code: "unknown" }]);
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

it("says the provider is overloaded when a streamed error reports it", () => {
	const overloaded = new Error(
		"Our servers are currently overloaded. Please try again later.",
	);
	overloaded.name = "AI_StreamProviderError";
	expect(apiModelFailureMessage(overloaded)).toBe(
		"The provider is overloaded right now. Work is preserved; retry this turn in a minute. No fallback was used.",
	);
	expect(apiModelFailureMessage(new Error("something else"))).toContain(
		"without a usable provider reason",
	);
});

/** Shaped like Effect's Data.TaggedError, which the domain layer cannot import. */
function taggedMachineError(
	tag: "WorkspaceProvisionError" | "WorkspaceCommandError",
	message: string,
) {
	return Object.assign(new Error(message), { name: tag, _tag: tag });
}

it("reports a machine that failed to start as a machine failure, not a model failure", () => {
	const error = taggedMachineError(
		"WorkspaceProvisionError",
		"conflict: vm vm-b216dc11cca64b34bb598aebc1b6fd79 has used its total runtime budget of 900s (903s used); raise maxRunTotalSeconds to start it again",
	);
	// The model loop wraps stream errors, including step preparation's.
	const wrapped = new SafeApiModelFailure(error);
	for (const message of [
		wrapped.message,
		apiTurnFailureMessage("model", wrapped),
		apiTurnFailureMessage("workspace", error),
	]) {
		expect(message).toContain("The chat's machine could not start");
		expect(message).toContain("Retry; your work is preserved");
		expect(message).not.toMatch(/model request failed|provider reason/i);
		expect(message).not.toContain("vm-b216");
		expect(message).not.toContain("maxRunTotalSeconds");
	}
	expect(apiTurnFailureClassification(error).name).toBe(
		"WorkspaceProvisionError",
	);
});

it("names a provider internal error on a machine as temporary without echoing it", () => {
	const message = apiModelFailureMessage(
		new SafeApiModelFailure(
			taggedMachineError("WorkspaceProvisionError", "Internal server error"),
		),
	);
	expect(message).toBe(
		"The chat's machine could not start: the machine provider returned a temporary error. Retry; your work is preserved.",
	);
});

it("says the chat's machine reached its usage limit when the budget cannot fund it", () => {
	for (const error of [
		new MachineUsageLimitReached(),
		taggedMachineError(
			"WorkspaceProvisionError",
			"Your cloud execution allowance is exhausted.",
		),
		taggedMachineError(
			"WorkspaceProvisionError",
			"The fleet cloud execution budget is exhausted.",
		),
	])
		expect(apiTurnFailureMessage("model", error)).toMatch(
			/^This chat's machine reached its usage limit/,
		);
});

it("keeps unknown machine error text out of the user message", () => {
	const message = apiTurnFailureMessage(
		"model",
		taggedMachineError(
			"WorkspaceCommandError",
			"token sk-secret at https://vm-x.style.dev failed",
		),
	);
	expect(message).toBe(
		"The chat's machine could not be reached: the machine provider reported an error. Retry; your work is preserved.",
	);
});

it("leaves non-machine failures to the existing provider wording", () => {
	expect(apiModelFailureMessage(new Error("something odd"))).toContain(
		"without a usable provider reason",
	);
});

it("says the repository could not be fetched when a Git proxy transfer fails", () => {
	const fetch = new Error(
		"Workspace Git proxy transfer failed; check repository access.",
	);
	for (const error of [
		fetch,
		new SafeApiModelFailure(new Error("fiber failure", { cause: fetch })),
	]) {
		const message = apiModelFailureMessage(error);
		expect(message).toContain("could not fetch its repository from GitHub");
		expect(message).not.toContain("model request failed");
	}
});

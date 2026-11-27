import { describe, expect, it } from "vitest";
import { MachineNotResponding, TURN_NOT_STARTED } from "./api-turn-failure";
import { CoordinationFailure } from "./conversation-turn-control";
import {
	GENUINE_STEP_RETRIES,
	isEdgeOutage,
	isTransientInfrastructureFailure,
	MAX_TRANSIENT_ATTEMPTS,
	shouldRetryStep,
	stepRetryDelayMs,
	TRANSIENT_RETRY_WINDOW_MS,
} from "./turn-interruption";

describe("machine start trouble is absorbed", () => {
	const provision = (message: string) =>
		Object.assign(new Error(message), {
			name: "WorkspaceProvisionError",
			detail: "",
		});
	it("resumes the step for a started VM that does not answer, or does not become running", () => {
		for (const message of [
			"Agent session VM started but is not answering yet. Try again in a minute.",
			"Workspace VM did not become running",
			"Workspace VM stopped before it became running",
			"another operation is updating this machine",
		])
			expect(isTransientInfrastructureFailure(provision(message))).toBe(true);
	});
	it("still fails fast for refusals no retry can fix", () => {
		for (const message of [
			"the provider rejected the xl machine size",
			"this deployment must be configured",
		])
			expect(isTransientInfrastructureFailure(provision(message))).toBe(false);
	});
});

describe("every provider-reported machine error is absorbed except terminal ones", () => {
	const machine = (message: string, detail = "") =>
		Object.assign(new Error(message), {
			name: "WorkspaceProvisionError",
			detail,
		});
	it("retries whatever the provider said: 4xx, 5xx, not found, an unknown body", () => {
		for (const detail of [
			"FreestyleApiError 404 NOT_FOUND /v5/vms/vm-x: not found: vm vm-x",
			"FreestyleApiError 400 BAD_REQUEST /v5/vms: invalid snapshot",
			"FreestyleApiError 409 CONFLICT /v5/vms/x/start",
			"FreestyleApiError 422 UNPROCESSABLE",
			"FreestyleApiError 500 INTERNAL_SERVER_ERROR",
			"something nobody has seen before",
		])
			expect(
				isTransientInfrastructureFailure(
					machine("Workspace provider error", detail),
				),
			).toBe(true);
		const exec = Object.assign(new Error("Workspace request (unavailable)"), {
			name: "WorkspaceCommandError",
		});
		expect(isTransientInfrastructureFailure(exec)).toBe(true);
	});
	it("does not retry what no retry can fix", () => {
		for (const message of [
			"This chat's machine reached its usage limit, so it cannot start.",
			"the provider rejected the xl machine size",
			"this deployment must be configured",
		])
			expect(isTransientInfrastructureFailure(machine(message))).toBe(false);
	});
});

describe("turn interruption rules", () => {
	it("treats coordinator, lease and start-wait trouble as transient", () => {
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure(
					"renew",
					{ kind: "transport", category: "timeout" },
					1,
				),
			),
		).toBe(true);
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure("renew", { kind: "http", status: 503 }, 3),
			),
		).toBe(true);
		for (const message of [
			TURN_NOT_STARTED,
			"Conversation coordination lease was lost.",
			"Turn heartbeat or coordination service became unavailable.",
		])
			expect(isTransientInfrastructureFailure(new Error(message))).toBe(true);
	});
	it("treats a machine that stayed down through a whole recovery as transient", () => {
		expect(
			isTransientInfrastructureFailure(
				new MachineNotResponding(new Error("x")),
			),
		).toBe(true);
	});
	it("never retries a refusal, a Stop or an ordinary bug as infrastructure", () => {
		expect(
			isTransientInfrastructureFailure(
				new CoordinationFailure("acquire", { kind: "http", status: 409 }, 1),
			),
		).toBe(false);
		expect(
			isTransientInfrastructureFailure(
				new Error("Turn ownership or cancellation state changed."),
			),
		).toBe(false);
		expect(isTransientInfrastructureFailure(new Error("boom"))).toBe(false);
		expect(isTransientInfrastructureFailure(undefined)).toBe(false);
	});
	it("recognises an edge outage by status", () => {
		const refused = Object.assign(new Error("x"), {
			name: "TurnBoxVmRefused",
			status: 503,
		});
		expect(isEdgeOutage(refused)).toBe(true);
		expect(isEdgeOutage(Object.assign(refused, { status: 403 }))).toBe(false);
	});
	it("backs off 5, 10, 20, 40, then 60 s", () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(stepRetryDelayMs)).toEqual([
			5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
	});
	it("waits out infrastructure trouble for the whole window, not 3 tries", () => {
		const start = 1_000_000;
		const at = (failures: number, elapsed: number) =>
			shouldRetryStep({
				transient: true,
				failures,
				firstFailureAt: start,
				now: start + elapsed,
			});
		expect(at(4, 60_000)).toBe(true);
		expect(at(MAX_TRANSIENT_ATTEMPTS - 1, TRANSIENT_RETRY_WINDOW_MS - 1)).toBe(
			true,
		);
		expect(at(5, TRANSIENT_RETRY_WINDOW_MS)).toBe(false);
		expect(at(MAX_TRANSIENT_ATTEMPTS, 1)).toBe(false);
	});
	it("keeps the old bound for a step failing for another reason", () => {
		const base = { transient: false, firstFailureAt: 0, now: 0 };
		expect(shouldRetryStep({ ...base, failures: GENUINE_STEP_RETRIES })).toBe(
			true,
		);
		expect(
			shouldRetryStep({ ...base, failures: GENUINE_STEP_RETRIES + 1 }),
		).toBe(false);
	});
});

describe("machine refusals that pass with time", () => {
	const provision = (message: string, detail = "") =>
		Object.assign(new Error(message), {
			name: "WorkspaceProvisionError",
			detail,
		});
	it("treats the provider's limit and our own creation count as infrastructure trouble to wait out", () => {
		expect(
			isTransientInfrastructureFailure(
				provision("The machine provider is limiting requests right now."),
			),
		).toBe(true);
		expect(
			isTransientInfrastructureFailure(
				provision(
					"Could not start",
					"FreestyleApiError 429 LIMIT_EXCEEDED /v5/vms: Account resource limit exceeded",
				),
			),
		).toBe(true);
		expect(
			isTransientInfrastructureFailure(
				provision(
					"This account started too many new machines in the last hour. Wait a few minutes, then retry; your work is preserved.",
				),
			),
		).toBe(true);
	});
	it("does not retry a refusal that will not pass", () => {
		expect(
			isTransientInfrastructureFailure(
				provision("the provider rejected the xl machine size"),
			),
		).toBe(false);
	});
});

it("retries a local Git step that failed on the machine, never a GitHub fetch refusal", () => {
	expect(
		isTransientInfrastructureFailure(new Error("Workspace Git checkout failed")),
	).toBe(true);
	expect(
		isTransientInfrastructureFailure(
			new Error("Workspace Git proxy transfer failed"),
		),
	).toBe(false);
});

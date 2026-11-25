import { FreestyleApiError } from "freestyle";
import { describe, expect, it } from "vitest";
import {
	ENVIRONMENT_MACHINE_AT_CAPACITY,
	ENVIRONMENT_MACHINE_NOT_STARTED,
	EnvironmentMachineFailure,
	environmentMachineFailure,
} from "./environment-build-failure";

function limitExceeded() {
	return new FreestyleApiError(
		429,
		{ code: "LIMIT_EXCEEDED", message: "Account resource limit exceeded" },
		"/v5/vms",
	);
}

describe("environmentMachineFailure", () => {
	it("says the provider is at capacity, not that the repository setup is wrong", () => {
		const failure = environmentMachineFailure(limitExceeded());
		expect(failure).toBeInstanceOf(EnvironmentMachineFailure);
		expect(failure.message).toBe(ENVIRONMENT_MACHINE_AT_CAPACITY);
		expect(failure.message).not.toMatch(/setup commands/i);
		expect(failure.cause).toBeInstanceOf(FreestyleApiError);
	});

	it("names a machine that could not start for any other reason", () => {
		expect(environmentMachineFailure(new Error("boom")).message).toBe(
			ENVIRONMENT_MACHINE_NOT_STARTED,
		);
	});

	it("keeps a failure that already is one", () => {
		const failure = environmentMachineFailure(new Error("x"));
		expect(environmentMachineFailure(failure)).toBe(failure);
	});
});

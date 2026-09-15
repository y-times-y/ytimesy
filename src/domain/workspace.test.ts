import { describe, expect, it } from "vitest";
import { guestMutationBlockedReason } from "./workspace";

describe("guestMutationBlockedReason", () => {
	it("blocks exec and writes on paused or stopped VMs", () => {
		expect(guestMutationBlockedReason("paused")).toBe(
			"Workspace VM is paused.",
		);
		expect(guestMutationBlockedReason("stopped")).toBe(
			"Workspace VM is paused.",
		);
	});

	it("allows mutation on a running VM", () => {
		expect(guestMutationBlockedReason("running")).toBeNull();
	});
});

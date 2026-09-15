import { describe, expect, it } from "vitest";
import { projectCheckoutPath } from "./project-checkout";

describe("projectCheckoutPath", () => {
	it("puts the repository in the guest home directory", () => {
		expect(projectCheckoutPath("/home/ubuntu", "ytimesy")).toBe(
			"/home/ubuntu/ytimesy",
		);
	});
});

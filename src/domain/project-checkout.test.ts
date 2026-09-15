import { describe, expect, it } from "vitest";
import {
	projectCheckoutFromFullName,
	projectCheckoutPath,
} from "./project-checkout";

describe("projectCheckoutPath", () => {
	it("puts the repository in the guest home directory", () => {
		expect(projectCheckoutPath("/home/ubuntu", "ytimesy")).toBe(
			"/home/ubuntu/ytimesy",
		);
	});
});

describe("projectCheckoutFromFullName", () => {
	it("splits owner/name from a tenant project", () => {
		expect(
			projectCheckoutFromFullName({
				fullName: "y-times-y/ytimesy",
				branch: "master",
				installationId: 161432829,
			}),
		).toEqual({
			owner: "y-times-y",
			name: "ytimesy",
			fullName: "y-times-y/ytimesy",
			branch: "master",
			installationId: "161432829",
		});
	});
});

describe("projectCheckoutPath", () => {
	it("puts the repository in the guest home directory", () => {
		expect(projectCheckoutPath("/home/ubuntu", "ytimesy")).toBe(
			"/home/ubuntu/ytimesy",
		);
	});
});

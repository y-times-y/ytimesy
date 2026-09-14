import { describe, expect, it } from "vitest";
import {
	FREESTYLE_EXEC_TIMEOUT_MS_MAX,
	freestyleExecTimeoutMs,
	productCreateVmFields,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

describe("productCreateVmFields", () => {
	it("creates a durable workspace VM without a short proof TTL", () => {
		expect(productCreateVmFields({ slug: "ytimesy-ws-abc" })).toEqual({
			slug: "ytimesy-ws-abc",
			displayName: "ytimesy workspace",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
			idleTimeoutSeconds: -1,
		});
	});

	it("boots from a private Codex snapshot when the user has one", () => {
		expect(
			productCreateVmFields({
				slug: "ytimesy-ws-abc",
				snapshotId: "sh-user-codex",
			}),
		).toMatchObject({ snapshotId: "sh-user-codex", idleTimeoutSeconds: -1 });
	});
});

describe("freestyleExecTimeoutMs", () => {
	it("caps at the Freestyle exec-await maximum", () => {
		expect(freestyleExecTimeoutMs(15 * 60 * 1000)).toBe(
			FREESTYLE_EXEC_TIMEOUT_MS_MAX,
		);
		expect(freestyleExecTimeoutMs(12_000)).toBe(12_000);
	});
});

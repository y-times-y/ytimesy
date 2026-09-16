import { describe, expect, it } from "vitest";
import {
	CHEAP_BASE_SNAPSHOT,
	FREESTYLE_EXEC_TIMEOUT_MS_MAX,
	freestyleExecTimeoutMs,
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productIdleTimeoutNeedsUpdate,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

describe("productCreateVmFields", () => {
	it("boots the cheap Ubuntu image and pauses when unused", () => {
		expect(productCreateVmFields({ slug: "ytimesy-ws-abc" })).toEqual({
			slug: "ytimesy-ws-abc",
			displayName: "ytimesy workspace",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
			idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
			snapshotId: CHEAP_BASE_SNAPSHOT,
		});
	});

	it("copies a private snapshot as-is because resize cannot shrink vCPU", () => {
		expect(
			productCreateVmFields({
				slug: "ytimesy-ws-abc",
				snapshotId: "sh-user-codex",
			}),
		).toMatchObject({
			snapshotId: "sh-user-codex",
			idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
		});
		expect(productIdleTimeoutNeedsUpdate(-1)).toBe(true);
		expect(productIdleTimeoutNeedsUpdate(PRODUCT_IDLE_TIMEOUT_SECONDS)).toBe(
			false,
		);
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

import { describe, expect, it } from "vitest";
import {
	CHEAP_BASE_SNAPSHOT,
	FREESTYLE_EXEC_TIMEOUT_MS_MAX,
	freestyleExecTimeoutMs,
	PRODUCT_AUTO_DELETE_SECONDS,
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productIdleTimeoutNeedsUpdate,
	productLifecycleUpdate,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

describe("productCreateVmFields", () => {
	it("boots the cheap Ubuntu image, pauses when idle and is deleted after 30 days unused", () => {
		expect(PRODUCT_AUTO_DELETE_SECONDS).toBe(2_592_000);
		expect(productCreateVmFields({ slug: "ytimesy-ws-abc" })).toEqual({
			slug: "ytimesy-ws-abc",
			displayName: "ytimesy workspace",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
			idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
			autoDeleteSeconds: PRODUCT_AUTO_DELETE_SECONDS,
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

describe("productLifecycleUpdate", () => {
	it("adds only the lifecycle settings a VM is missing", () => {
		expect(
			productLifecycleUpdate({
				idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
				autoDeleteSeconds: PRODUCT_AUTO_DELETE_SECONDS,
			}),
		).toBeUndefined();
		// A VM made before auto-delete: only the window is added.
		expect(
			productLifecycleUpdate({
				idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
			}),
		).toEqual({ autoDeleteSeconds: PRODUCT_AUTO_DELETE_SECONDS });
		expect(
			productLifecycleUpdate({
				idleTimeoutSeconds: -1,
				autoDeleteSeconds: null,
			}),
		).toEqual({
			idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
			autoDeleteSeconds: PRODUCT_AUTO_DELETE_SECONDS,
		});
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

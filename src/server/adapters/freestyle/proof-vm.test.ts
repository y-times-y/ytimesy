import { describe, expect, it } from "vitest";
import {
	GUEST_INTERNET_FIREWALL,
	PROOF_METADATA_PURPOSE,
	privateCodexAuthSnapshotFields,
	proofAuthSnapshotSlug,
	proofCreateVmFields,
	requestedAuthSnapshotId,
} from "./proof-vm";

describe("proofCreateVmFields", () => {
	it("omits snapshotId so Freestyle uses the default image", () => {
		expect(proofCreateVmFields({ slug: "ytimesy-proof-abcd" })).toEqual({
			slug: "ytimesy-proof-abcd",
			displayName: "ytimesy workspace proof",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: PROOF_METADATA_PURPOSE },
			ttlSeconds: 20 * 60,
			idleTimeoutSeconds: 10 * 60,
		});
	});

	it("boots from a private auth snapshot when one is supplied", () => {
		expect(
			proofCreateVmFields({
				slug: "ytimesy-proof-efgh",
				snapshotId: "sh-user-codex",
				ttlSeconds: 45 * 60,
				idleTimeoutSeconds: -1,
			}),
		).toEqual({
			slug: "ytimesy-proof-efgh",
			displayName: "ytimesy workspace proof",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: PROOF_METADATA_PURPOSE },
			ttlSeconds: 45 * 60,
			idleTimeoutSeconds: -1,
			snapshotId: "sh-user-codex",
		});
	});
});

describe("privateCodexAuthSnapshotFields", () => {
	it("names a private user snapshot rather than a shared base image", () => {
		expect(privateCodexAuthSnapshotFields("a1b2")).toEqual({
			slug: proofAuthSnapshotSlug("a1b2"),
			displayName: "ytimesy isolated Codex ChatGPT login",
			autoDeleteSeconds: -1,
		});
		expect(privateCodexAuthSnapshotFields("a1b2")).not.toHaveProperty("public");
	});
});

describe("requestedAuthSnapshotId", () => {
	it("records only a snapshot we asked to boot from, not Freestyle's default image", () => {
		expect(requestedAuthSnapshotId("sh-user-codex")).toBe("sh-user-codex");
		expect(requestedAuthSnapshotId(undefined)).toBeNull();
	});
});

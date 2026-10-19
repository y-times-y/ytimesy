import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	desktopEdgeHostname,
	desktopViewerAuthorization,
	desktopViewerCredential,
	desktopViewerCredentialDigest,
	guestServiceHostname,
} from "./vm-edge-keys";

afterEach(() => vi.unstubAllEnvs());

it("derives unguessable, stable per-VM names and credentials from the server root", () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(40));
	const host = desktopEdgeHostname("vm-1");
	expect(host).toMatch(/^ytimesy-desk-[a-f0-9]{24}\.style\.dev$/);
	expect(host).not.toContain("vm1");
	expect(desktopEdgeHostname("vm-1")).toBe(host);
	expect(desktopEdgeHostname("vm-2")).not.toBe(host);
	expect(guestServiceHostname("vm-1", 41000)).toMatch(
		/^ytimesy-tools-[a-f0-9]{24}-41000\.style\.dev$/,
	);
	const credential = desktopViewerCredential("vm-1");
	expect(credential).toMatch(/^ytimesy:[a-f0-9]{40}$/);
	expect(desktopViewerAuthorization("vm-1")).toBe(
		`Basic ${Buffer.from(credential).toString("base64")}`,
	);
	expect(desktopViewerCredentialDigest("vm-1")).toBe(
		createHash("sha256").update(credential).digest("hex"),
	);
	vi.stubEnv("BETTER_AUTH_SECRET", "b".repeat(40));
	expect(desktopEdgeHostname("vm-1")).not.toBe(host);
});

it("prefers an explicit edge secret and refuses to run without one", () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(40));
	const derived = desktopViewerCredential("vm-1");
	vi.stubEnv("YTIMESY_VM_EDGE_SECRET", "c".repeat(40));
	expect(desktopViewerCredential("vm-1")).not.toBe(derived);
	vi.stubEnv("YTIMESY_VM_EDGE_SECRET", "");
	vi.stubEnv("BETTER_AUTH_SECRET", "short");
	expect(() => desktopViewerCredential("vm-1")).toThrow(
		"VM edge secret is not configured.",
	);
});

import { expect, it } from "vitest";
import {
	vmEdgeHostname,
	vmEdgeRouteIsSuperseded,
	vmEdgeRouteKind,
} from "./vm-edge-routes";

const label = "0123456789abcdef0123456789abcdef";

it("names routes from a keyed label, truncated to 96 bits", () => {
	expect(vmEdgeHostname("desk", label)).toBe(
		"ytimesy-desk-0123456789abcdef01234567.style.dev",
	);
	expect(vmEdgeHostname("pv", label, 3000)).toBe(
		"ytimesy-pv-0123456789abcdef01234567-3000.style.dev",
	);
	expect(() => vmEdgeHostname("desk", "vm-123")).toThrow();
});

it("recognizes our routes, including the legacy unkeyed names", () => {
	expect(vmEdgeRouteKind("ytimesy-desk-abc123.style.dev")).toBe("desk");
	expect(vmEdgeRouteKind("ytimesy-tools-abcdef012345-41234.style.dev")).toBe(
		"tools",
	);
	expect(vmEdgeRouteKind("ytimesy-share-x-3000.style.dev")).toBe("share");
	expect(vmEdgeRouteKind("app.example.com")).toBeNull();
	expect(vmEdgeRouteKind("ytimesy-desk-abc.example.com")).toBeNull();
});

it("supersedes every other desktop or tool route, but previews only per port", () => {
	const desk = { domain: vmEdgeHostname("desk", label), port: 6080 };
	expect(
		vmEdgeRouteIsSuperseded(
			{ domain: "ytimesy-desk-legacy.style.dev", port: 6080 },
			desk,
		),
	).toBe(true);
	expect(vmEdgeRouteIsSuperseded(desk, desk)).toBe(false);
	const tools = {
		domain: vmEdgeHostname("tools", label, 40001),
		port: 40001,
	};
	expect(
		vmEdgeRouteIsSuperseded(
			{ domain: vmEdgeHostname("tools", label, 39999), port: 39999 },
			tools,
		),
	).toBe(true);
	const preview = { domain: vmEdgeHostname("pv", label, 3000), port: 3000 };
	expect(
		vmEdgeRouteIsSuperseded(
			{ domain: vmEdgeHostname("pv", label, 5173), port: 5173 },
			preview,
		),
	).toBe(false);
	expect(
		vmEdgeRouteIsSuperseded(
			{ domain: "ytimesy-pv-older-3000.style.dev", port: 3000 },
			preview,
		),
	).toBe(true);
	expect(vmEdgeRouteIsSuperseded(desk, preview)).toBe(false);
});

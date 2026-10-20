import { expect, it } from "vitest";
import {
	CodexEgressHealth,
	relayEgressBlock,
	upstreamEgressBlock,
} from "./codex-egress";

const upstream = (status: number, text: string, headers?: HeadersInit) =>
	upstreamEgressBlock({ status, text, headers: new Headers(headers) });

it("treats HTML rejections, challenges, Cloudflare block pages and edge 5xx as the path's", () => {
	expect(upstream(403, "<html>Forbidden</html>")).toBe("forbidden-html");
	expect(upstream(403, "")).toBe("forbidden-html");
	expect(upstream(401, "<!doctype html><title>401</title>")).toBe(
		"unauthorized-html",
	);
	expect(upstream(403, "<html>", { "cf-mitigated": "challenge" })).toBe(
		"challenge",
	);
	expect(upstream(403, "error code: 1020")).toBe("cloudflare-block");
	expect(upstream(403, "<p>Error 1010</p> error code 1010")).toBe(
		"cloudflare-block",
	);
	expect(upstream(502, "<html>Bad gateway</html>")).toBe("gateway-error");
	expect(upstream(302, "")).toBe("redirect");
});

it("never treats account or request errors as a blocked path", () => {
	expect(upstream(200, "")).toBeNull();
	expect(
		upstream(401, '{"error":{"code":"token_expired","message":"expired"}}'),
	).toBeNull();
	// The revoked-token answer the refresh path already handled.
	expect(upstream(401, "")).toBeNull();
	expect(upstream(429, "<html>Too many</html>")).toBeNull();
	expect(
		upstream(429, '{"error":{"type":"usage_limit_reached","resets_at":1}}'),
	).toBeNull();
	expect(upstream(400, '{"error":{"message":"bad input"}}')).toBeNull();
	expect(upstream(403, '{"detail":"model not allowed on plan"}')).toBeNull();
	expect(upstream(404, "Not found")).toBeNull();
	expect(upstream(500, '{"error":{"type":"server_error"}}')).toBeNull();
});

it("reads the relay's own classification and treats a broken relay as blocked", () => {
	const relay = (status: number, body: unknown) =>
		relayEgressBlock({
			status,
			text: typeof body === "string" ? body : JSON.stringify(body),
		});
	expect(relay(200, "")).toBeNull();
	expect(relay(403, { error: { type: "subscription_egress_blocked" } })).toBe(
		"forbidden-html",
	);
	expect(relay(502, { error: { type: "subscription_transport_error" } })).toBe(
		"transport",
	);
	expect(
		relay(401, { error: { type: "subscription_upstream_error" } }),
	).toBeNull();
	expect(relay(429, { error: { type: "usage_limit_reached" } })).toBeNull();
	// Bad signature, missing key, or another service at that URL.
	expect(relay(401, "")).toBe("relay-unavailable");
	expect(relay(503, "")).toBe("relay-unavailable");
	expect(relay(404, "<html>not found</html>")).toBe("relay-unavailable");
	expect(relay(307, "")).toBe("redirect");
});

it("skips a blocked path for its cooldown, keeps it as a last resort, then probes it again", () => {
	let now = 0;
	const health = new CodexEgressHealth(300_000, () => now);
	const paths = [{ id: "vpc" }, { id: "relay-1" }, { id: "relay-2" }];
	expect(health.order(paths).map((path) => path.id)).toEqual([
		"vpc",
		"relay-1",
		"relay-2",
	]);
	now = 1_000;
	expect(health.markBlocked("relay-1", "timeout")).toBe(true);
	now = 2_000;
	expect(health.markBlocked("vpc", "forbidden-html")).toBe(true);
	// A repeat within the cooldown is not a new incident.
	expect(health.markBlocked("vpc", "forbidden-html")).toBe(false);
	// Healthy first; cooling paths last, soonest-expiring first.
	expect(health.order(paths).map((path) => path.id)).toEqual([
		"relay-2",
		"relay-1",
		"vpc",
	]);
	expect(health.snapshot()["relay-1"]).toEqual({
		reason: "timeout",
		coolingMs: 299_000,
	});
	now = 301_500;
	expect(health.order(paths).map((path) => path.id)).toEqual([
		"relay-1",
		"relay-2",
		"vpc",
	]);
	now = 302_000;
	expect(health.order(paths).map((path) => path.id)).toEqual([
		"vpc",
		"relay-1",
		"relay-2",
	]);
	expect(health.markHealthy("vpc")).toBe(true);
	expect(health.markHealthy("vpc")).toBe(false);
});

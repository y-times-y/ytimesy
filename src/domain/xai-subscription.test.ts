import { describe, expect, it } from "vitest";
import {
	XAI_REFUSAL_COOLDOWN_MS,
	xaiConnectionMayServe,
	xaiForbiddenVerdict,
	xaiLogSnippet,
	xaiRefreshRejected,
	xaiSubscriptionMessage,
	xaiSubscriptionNeedsSignIn,
} from "./xai-subscription";

describe("xaiConnectionMayServe", () => {
	it("serves a ready connection", () => {
		expect(xaiConnectionMayServe("ready", 0)).toBe(true);
	});
	it("tries a refused connection again once the cooldown has passed", () => {
		expect(xaiConnectionMayServe("not-eligible", 1_000)).toBe(false);
		expect(xaiConnectionMayServe("not-eligible", XAI_REFUSAL_COOLDOWN_MS)).toBe(
			true,
		);
	});
	it("keeps a rejected sign-in waiting for the user", () => {
		expect(
			xaiConnectionMayServe("reconnect", 10 * XAI_REFUSAL_COOLDOWN_MS),
		).toBe(false);
	});
});

describe("xaiForbiddenVerdict", () => {
	it("records a refusal that explicitly refuses the plan", () => {
		expect(
			xaiForbiddenVerdict(
				'{"error":"Your subscription does not include Grok"}',
			),
		).toBe("not-eligible");
		expect(
			xaiForbiddenVerdict("This account is not eligible for Grok via OAuth."),
		).toBe("not-eligible");
		expect(
			xaiForbiddenVerdict(
				"This model requires a SuperGrok Heavy subscription.",
			),
		).toBe("not-eligible");
	});

	it("reads xAI's spent-plan 403s as a usage limit, though they name the subscription", () => {
		// The chat 403 users get when the plan's usage is spent (Hermes #26847).
		expect(
			xaiForbiddenVerdict(
				JSON.stringify({
					code: "The caller does not have permission to execute the specified operation",
					error:
						"You have either run out of available resources or do not have an active Grok subscription. Manage your subscription at https://grok.com/?_s=usage or subscribe at https://grok.com/supergrok.",
				}),
			),
		).toBe("usage-limit");
		// The spending-limit 403 on api.x.ai (CLIProxyAPI #5335).
		expect(
			xaiForbiddenVerdict(
				JSON.stringify({
					code: "personal-team-blocked:spending-limit",
					error:
						"You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.",
				}),
			),
		).toBe("usage-limit");
		expect(
			xaiForbiddenVerdict(
				"You've reached your plan's limit. Upgrade to SuperGrok Heavy for more.",
			),
		).toBe("usage-limit");
		expect(xaiForbiddenVerdict("request blocked by rate limit")).toBe(
			"usage-limit",
		);
	});

	it("records nothing for an empty, unrelated or edge 403", () => {
		expect(xaiForbiddenVerdict("")).toBe("unavailable");
		expect(xaiForbiddenVerdict("Forbidden")).toBe("unavailable");
		expect(
			xaiForbiddenVerdict(
				"<html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked</html>",
			),
		).toBe("unavailable");
		// Naming the plan is no longer enough on its own.
		expect(xaiForbiddenVerdict("Upgrade to SuperGrok for more models")).toBe(
			"unavailable",
		);
	});
});

describe("xaiRefreshRejected", () => {
	it("ends the sign-in only on an OAuth error that kills the grant", () => {
		expect(
			xaiRefreshRejected(
				400,
				'{"error":"invalid_grant","error_description":"Refresh token has been revoked"}',
			),
		).toBe(true);
		expect(
			xaiRefreshRejected(
				400,
				'{"error":"invalid_grant","error_description":"Invalid or unknown refresh token"}',
			),
		).toBe(true);
		expect(xaiRefreshRejected(401, '{"error":"invalid_client"}')).toBe(true);
	});
	it("treats anything else from the token endpoint as passing", () => {
		expect(xaiRefreshRejected(400, '{"error":"invalid_request"}')).toBe(false);
		expect(xaiRefreshRejected(403, "<html>blocked</html>")).toBe(false);
		expect(xaiRefreshRejected(403, '{"error":"invalid_grant"}')).toBe(false);
		expect(xaiRefreshRejected(401, "")).toBe(false);
		expect(xaiRefreshRejected(503, '{"error":"invalid_grant"}')).toBe(false);
	});
});

describe("xaiLogSnippet", () => {
	it("keeps the body readable and drops anything token-shaped", () => {
		const snippet = xaiLogSnippet(
			'{"error":"bad",\n "access_token":"opaque-secret","detail":"Bearer abc.def eyJhbGciOi.eyJzdWIi.sig"}',
		);
		expect(snippet).toContain('"error":"bad"');
		expect(snippet).not.toContain("opaque-secret");
		expect(snippet).not.toContain("abc.def");
		expect(snippet).not.toContain("eyJhbGciOi");
		expect(snippet).not.toContain("\n");
		expect(xaiLogSnippet("x".repeat(1_000))).toHaveLength(300);
	});
});

describe("what Settings asks of the user", () => {
	it("asks for sign-in only when signed out or the sign-in was rejected", () => {
		expect(xaiSubscriptionNeedsSignIn("disconnected")).toBe(true);
		expect(xaiSubscriptionNeedsSignIn("reconnect")).toBe(true);
		expect(xaiSubscriptionNeedsSignIn("ready")).toBe(false);
		expect(xaiSubscriptionNeedsSignIn("not-eligible")).toBe(false);
	});
	it("does not tell a retried refusal to reconnect", () => {
		expect(xaiSubscriptionMessage("not-eligible")).not.toMatch(
			/reconnect|sign in/i,
		);
		expect(xaiSubscriptionMessage("reconnect")).toMatch(/reconnect/i);
	});
});

import { describe, expect, it } from "vitest";
import { analyticsSurface, filteredAnalyticsProperties } from "./analytics";

describe("analytics privacy boundary", () => {
	it("strips prompts, credentials, URLs, and SDK metadata", () => {
		expect(
			filteredAnalyticsProperties("prompt_submitted", {
				runtime: "codex",
				attempts: 2,
				prompt: "private code",
				api_key: "secret",
				$current_url: "https://example.com/?token=secret",
				$referrer: "private repo",
			}),
		).toEqual({ runtime: "codex", attempts: 2 });
	});
	it("drops unknown, automatic, and malformed events", () => {
		for (const event of [
			"$pageview",
			"$exception",
			"$snapshot",
			"unknown",
			"toString",
		])
			expect(filteredAnalyticsProperties(event, {})).toBeNull();
		expect(
			filteredAnalyticsProperties("prompt_submitted", {
				runtime: "secret",
				attempts: 1,
			}),
		).toBeNull();
		expect(
			filteredAnalyticsProperties("prompt_submitted", {
				runtime: "codex",
				attempts: 6,
			}),
		).toBeNull();
	});
	it("identifies without email or profile attributes", () => {
		expect(
			filteredAnalyticsProperties("$identify", {
				$anon_distinct_id: "random-id",
				$set: { email: "private" },
			}),
		).toEqual({ $anon_distinct_id: "random-id" });
	});
	it("classifies routes without private identifiers", () => {
		expect(analyticsSurface("/")).toBe("workspace");
		expect(analyticsSurface("/auth/sign-in")).toBe("auth");
		expect(analyticsSurface("/onboarding")).toBe("onboarding");
		expect(analyticsSurface("/private/repository")).toBe("other");
	});
});

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
	it("keeps a pageview's origin, path and referring domain only", () => {
		expect(
			filteredAnalyticsProperties("$pageview", {
				$current_url: "https://ytimesy.com/blog/harness-1-0?ref=x#top",
				$pathname: "/blog/harness-1-0",
				$referring_domain: "t.co",
				$referrer: "https://t.co/abc?secret=1",
				$browser: "Chrome",
				title: "private",
			}),
		).toEqual({
			$current_url: "https://ytimesy.com/blog/harness-1-0",
			$host: "ytimesy.com",
			$pathname: "/blog/harness-1-0",
			$referring_domain: "t.co",
		});
		expect(
			filteredAnalyticsProperties("$pageview", {
				$current_url: "https://ytimesy.com/projects/p-123/sessions/s-9",
				$referring_domain: "$direct",
			}),
		).toMatchObject({ $pathname: "/projects", $referring_domain: "$direct" });
		expect(
			filteredAnalyticsProperties("$pageview", {
				$current_url: "https://ytimesy.com/auth/reset-password?token=t",
			}),
		).toBeNull();
		expect(
			filteredAnalyticsProperties("$pageview", {
				$current_url: "https://ytimesy.com/",
				$referring_domain: "https://evil/?x",
			}),
		).toEqual({
			$current_url: "https://ytimesy.com/",
			$host: "ytimesy.com",
			$pathname: "/",
		});
	});
	it("keeps a pageleave's page and previous-page numbers only", () => {
		expect(
			filteredAnalyticsProperties("$pageleave", {
				$current_url: "https://ytimesy.com/projects/p-1?tab=x",
				$prev_pageview_pathname: "/projects/p-1",
				$prev_pageview_duration: 12.5,
				$prev_pageview_max_scroll_percentage: 0.8,
				$prev_pageview_last_content: "not a number",
				$el_text: "private",
			}),
		).toEqual({
			$current_url: "https://ytimesy.com/projects",
			$host: "ytimesy.com",
			$pathname: "/projects",
			$prev_pageview_pathname: "/projects",
			$prev_pageview_duration: 12.5,
			$prev_pageview_max_scroll_percentage: 0.8,
		});
	});
	it("keeps web vitals values and drops their attribution", () => {
		expect(
			filteredAnalyticsProperties("$web_vitals", {
				$current_url: "https://ytimesy.com/blog?x=1",
				$web_vitals_LCP_value: 1234,
				$web_vitals_LCP_event: { attribution: { element: "#private" } },
				$web_vitals_CLS_value: 0.02,
				$web_vitals_INP_value: Number.NaN,
			}),
		).toEqual({
			$current_url: "https://ytimesy.com/blog",
			$host: "ytimesy.com",
			$pathname: "/blog",
			$web_vitals_LCP_value: 1234,
			$web_vitals_CLS_value: 0.02,
		});
		expect(
			filteredAnalyticsProperties("$web_vitals", {
				$current_url: "https://ytimesy.com/",
			}),
		).toBeNull();
		expect(
			filteredAnalyticsProperties("$web_vitals", {
				$current_url: "https://ytimesy.com/auth/reset-password?token=t",
				$web_vitals_LCP_value: 1,
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

it("lets app_viewed carry the first-touch ref and source, nothing else from the cookie", () => {
	expect(
		filteredAnalyticsProperties("app_viewed", {
			surface: "other",
			initial_ref: "x",
			initial_utm_source: "twitter",
			initial_landing_path: "/blog",
		}),
	).toEqual({
		surface: "other",
		initial_ref: "x",
		initial_utm_source: "twitter",
	});
	expect(
		filteredAnalyticsProperties("app_viewed", {
			surface: "other",
			initial_ref: "Bad Ref",
		}),
	).toBeNull();
});

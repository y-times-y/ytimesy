import { describe, expect, it } from "vitest";
import { filteredAnalyticsProperties } from "./analytics";
import { analyticsRoute, deviceClass, replyStartedAfter } from "./web-vitals";

describe("speed reports", () => {
	it("keeps the route template, never ids", () => {
		expect(analyticsRoute("/")).toBe("/");
		expect(analyticsRoute("/onboarding/")).toBe("/onboarding");
		expect(analyticsRoute("/auth/sign-in")).toBe("/auth/$path");
		expect(analyticsRoute("/projects/abc-123/evidence/def-456")).toBe(
			"/projects/$projectId/evidence/$evidenceId",
		);
		expect(analyticsRoute("/projects/abc/pulls/42/fix")).toBe(
			"/projects/$projectId/pulls/$linkId/fix",
		);
		expect(analyticsRoute("/projects/abc/secret-path")).toBe("other");
	});

	it("sorts devices into three classes", () => {
		expect(deviceClass({ width: 390, coarsePointer: true })).toBe("mobile");
		expect(deviceClass({ width: 820, coarsePointer: true })).toBe("tablet");
		expect(deviceClass({ width: 1180, coarsePointer: true })).toBe("tablet");
		expect(deviceClass({ width: 1180, coarsePointer: false })).toBe("desktop");
		expect(deviceClass({ width: 1440, coarsePointer: false })).toBe("desktop");
	});

	it("sends only the metric, its numbers and categories", () => {
		expect(
			filteredAnalyticsProperties("web_vital", {
				metric: "LCP",
				value: 1830,
				rating: "good",
				navigation: "navigate",
				route: "/",
				device: "desktop",
				$current_url: "https://ytimesy.com/?chat=private",
				element: "div.session-title",
			}),
		).toEqual({
			metric: "LCP",
			value: 1830,
			rating: "good",
			navigation: "navigate",
			route: "/",
			device: "desktop",
		});
		expect(
			filteredAnalyticsProperties("interaction_timing", {
				interaction: "first_token",
				duration_ms: 2400,
				route: "/",
				device: "mobile",
				text: "the prompt",
			}),
		).toEqual({
			interaction: "first_token",
			duration_ms: 2400,
			route: "/",
			device: "mobile",
		});
	});

	it("drops raw paths and impossible numbers", () => {
		const vital = {
			metric: "CLS",
			value: 0.02,
			rating: "good",
			route: "/",
			device: "desktop",
		};
		expect(
			filteredAnalyticsProperties("web_vital", {
				...vital,
				route: "/projects/abc/evidence/def",
			}),
		).toBeNull();
		expect(
			filteredAnalyticsProperties("web_vital", { ...vital, value: -1 }),
		).toBeNull();
		expect(
			filteredAnalyticsProperties("interaction_timing", {
				interaction: "chat_switch",
				duration_ms: 3_600_000,
				route: "/",
				device: "desktop",
			}),
		).toBeNull();
	});

	it("finds the agent's first output for the sent message only", () => {
		const user = (id: string) => ({ kind: "userMessage" as const, id });
		const agent = (id: string) => ({ kind: "agentMessage" as const, id });
		const notice = (id: string) => ({ kind: "notice" as const, id });
		const earlier = [user("u1"), agent("a1")];
		expect(replyStartedAfter(earlier, "u2")).toBe(false);
		expect(replyStartedAfter([...earlier, user("u2")], "u2")).toBe(false);
		expect(replyStartedAfter([...earlier, user("u2"), notice("n")], "u2")).toBe(
			false,
		);
		expect(replyStartedAfter([...earlier, user("u2"), agent("a2")], "u2")).toBe(
			true,
		);
		expect(
			replyStartedAfter(
				[...earlier, user("u2"), user("u3"), agent("a3")],
				"u2",
			),
		).toBe(false);
	});
});

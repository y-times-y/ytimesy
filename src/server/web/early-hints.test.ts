import { expect, it } from "vitest";
import { earlyHintLink } from "./early-hints";

const entry = (hint: Parameters<typeof earlyHintLink>[0]["hint"]) => ({
	phase: "static" as const,
	hint,
	link: "",
});

it("hints build-hashed assets and bare third-party origins", () => {
	expect(
		earlyHintLink(
			entry({ href: "/assets/index-Bq8.js", rel: "modulepreload" }),
		),
	).toBe(true);
	expect(
		earlyHintLink(
			entry({ href: "/assets/styles-B1.css", rel: "preload", as: "style" }),
		),
	).toBe(true);
	expect(
		earlyHintLink(
			entry({ href: "https://us.i.posthog.com", rel: "preconnect" }),
		),
	).toBe(true);
});

it("never hints a page or API URL", () => {
	expect(
		earlyHintLink(entry({ href: "/api/agent/progress", rel: "preload" })),
	).toBe(false);
	expect(
		earlyHintLink(
			entry({ href: "https://example.com/private?x=1", rel: "preconnect" }),
		),
	).toBe(false);
});

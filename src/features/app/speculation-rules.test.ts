import { expect, it } from "vitest";
import { SPECULATION_PAGES, SPECULATION_RULES } from "./speculation-rules";

it("prefetches only the static legal pages", () => {
	expect(JSON.parse(SPECULATION_RULES)).toEqual({
		prefetch: [
			{
				where: { href_matches: ["/terms", "/privacy", "/training"] },
				eagerness: "moderate",
			},
		],
	});
	expect(SPECULATION_PAGES).not.toContain("/");
	expect(JSON.parse(SPECULATION_RULES)).not.toHaveProperty("prerender");
});

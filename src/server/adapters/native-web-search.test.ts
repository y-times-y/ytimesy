import { expect, it } from "vitest";
import { nativeWebSearchTools } from "./native-web-search";

it("offers each provider's own hosted search and nothing for others", () => {
	expect(Object.keys(nativeWebSearchTools("openai"))).toEqual(["web_search"]);
	expect(Object.keys(nativeWebSearchTools("anthropic"))).toEqual([
		"web_search",
	]);
	expect(Object.keys(nativeWebSearchTools("google"))).toEqual([
		"google_search",
	]);
	expect(nativeWebSearchTools("openrouter")).toEqual({});
	expect(nativeWebSearchTools("compatible")).toEqual({});
	// Hosted tools run on the provider: no local execute for hooks or plan mode to wrap.
	for (const tool of Object.values(nativeWebSearchTools("openai")))
		expect((tool as { execute?: unknown }).execute).toBeUndefined();
});

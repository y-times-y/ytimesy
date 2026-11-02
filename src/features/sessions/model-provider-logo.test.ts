import { describe, expect, it } from "vitest";
import { modelLogoProvider } from "./model-provider-logo";

describe("modelLogoProvider", () => {
	it("reads a routed id's maker, and a bare id's family", () => {
		expect(modelLogoProvider("x-ai/grok-4.7")).toBe("grok");
		expect(modelLogoProvider("grok-4.7")).toBe("grok");
		expect(modelLogoProvider("openai/gpt-6.1-sol")).toBe("openai");
		expect(modelLogoProvider("gpt-6.1-sol")).toBe("openai");
		expect(modelLogoProvider("claude-opus-5-5")).toBe("anthropic");
		expect(modelLogoProvider("gemini-4-argon")).toBe("google");
		expect(modelLogoProvider("glm-5.3")).toBe("z-ai");
		expect(modelLogoProvider("")).toBe("openrouter");
	});
});

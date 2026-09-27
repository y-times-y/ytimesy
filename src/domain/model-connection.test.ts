import { describe, expect, it } from "vitest";
import {
	modelConnectionInput,
	modelRouteId,
	parseModelRouteId,
	publicModelEndpoint,
} from "./model-connection";

describe("model connections", () => {
	it.each([
		"http://example.com/v1",
		"https://user:secret@example.com",
		"https://example.com?key=secret",
		"https://example.com#secret",
		"https://example.com:8443",
	])("rejects unsafe endpoint syntax %s", (value) => {
		expect(() => publicModelEndpoint(value)).toThrow();
	});
	it("normalizes URLs and prevents overriding native endpoints", () => {
		expect(publicModelEndpoint("https://example.com/v1/")).toBe(
			"https://example.com/v1",
		);
		expect(
			modelConnectionInput.parse({
				provider: "openai",
				label: "Work",
				apiKey: "fixture-key",
				baseUrl: "https://elsewhere.example",
			}).baseUrl,
		).toBe("https://api.openai.com/v1");
	});
	it("round trips provider model IDs without mixing connections", () => {
		const connectionId = "12345678-1234-4123-8123-123456789012";
		expect(
			parseModelRouteId(modelRouteId(connectionId, "vendor/model:version")),
		).toEqual({ connectionId, modelId: "vendor/model:version" });
		expect(parseModelRouteId("api/wrong/model")).toBeNull();
		expect(parseModelRouteId(`api/${connectionId}/%xx`)).toBeNull();
	});
});

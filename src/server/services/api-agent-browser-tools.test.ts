import { expect, it } from "vitest";
import { safeBrowserUrl } from "./api-agent-browser-tools";

it("allows loopback preview pages", async () => {
	expect(await safeBrowserUrl("http://localhost:3000/preview")).toBe(
		"http://localhost:3000/preview",
	);
});

it("rejects unsafe schemes, credentials, and metadata addresses", async () => {
	await expect(safeBrowserUrl("file:///etc/passwd")).rejects.toThrow();
	await expect(
		safeBrowserUrl("https://user:pass@example.com/"),
	).rejects.toThrow();
	await expect(
		safeBrowserUrl("http://169.254.169.254/latest/meta-data/"),
	).rejects.toThrow();
	await expect(safeBrowserUrl("http://10.0.0.1/")).rejects.toThrow();
});

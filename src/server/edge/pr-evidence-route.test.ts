import { describe, expect, it, vi } from "vitest";
import { servePrEvidence } from "./pr-evidence-route";

const id = "0123456789abcdef0123456789abcdef";
const origin = "https://edge.example";

describe("evidence route", () => {
	it("serves stored media read-only with headers that stop script and sniffing", async () => {
		const fetchFile = vi.fn(
			async () =>
				new Response("png", {
					status: 200,
					headers: { "content-length": "3", "x-amz-meta-secret": "no" },
				}),
		);
		const response = await servePrEvidence(
			new Request(`${origin}/pr-evidence/${id}/01-home.png`),
			fetchFile,
		);
		expect(fetchFile).toHaveBeenCalledWith(
			`pr-evidence/${id}/01-home.png`,
			null,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("png");
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toContain(
			"sandbox",
		);
		expect(response.headers.get("x-amz-meta-secret")).toBeNull();
	});

	it("passes a range through for video seeking", async () => {
		const fetchFile = vi.fn(
			async () =>
				new Response("we", {
					status: 206,
					headers: { "content-range": "bytes 0-1/10" },
				}),
		);
		const response = await servePrEvidence(
			new Request(`${origin}/pr-evidence/${id}/recording.webm`, {
				headers: { range: "bytes=0-1" },
			}),
			fetchFile,
		);
		expect(fetchFile).toHaveBeenCalledWith(
			`pr-evidence/${id}/recording.webm`,
			"bytes=0-1",
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("content-type")).toBe("video/webm");
		expect(response.headers.get("content-range")).toBe("bytes 0-1/10");
	});

	it("never reaches other storage or writes", async () => {
		const fetchFile = vi.fn();
		for (const path of [
			`/pr-evidence/${id}/../checkpoints/x.png`,
			`/pr-evidence/${id}/%2e%2e/x.png`,
			`/pr-evidence/${id}/a.html`,
			"/pr-evidence/short/a.png",
			`/pr-evidence/${id}`,
		])
			expect(
				(await servePrEvidence(new Request(`${origin}${path}`), fetchFile))
					.status,
			).toBe(404);
		expect(
			(
				await servePrEvidence(
					new Request(`${origin}/pr-evidence/${id}/a.png`, {
						method: "PUT",
						body: "x",
					}),
					fetchFile,
				)
			).status,
		).toBe(405);
		expect(fetchFile).not.toHaveBeenCalled();
	});

	it("hides storage errors behind 404 and reports missing storage as 503", async () => {
		expect(
			(
				await servePrEvidence(
					new Request(`${origin}/pr-evidence/${id}/a.png`),
					async () => new Response("AccessDenied", { status: 403 }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await servePrEvidence(
					new Request(`${origin}/pr-evidence/${id}/a.png`),
					() => null,
				)
			).status,
		).toBe(503);
	});
});

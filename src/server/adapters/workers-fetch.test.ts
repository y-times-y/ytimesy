import { expect, it, vi } from "vitest";
import { redirectRefusingFetch } from "./workers-fetch";

it("asks for manual redirects where a library asks for error", async () => {
	const base = vi.fn(async () => new Response(null, { status: 302 }));
	const response = await redirectRefusingFetch(base as typeof fetch)(
		"https://mcp.example/",
		{ method: "POST", redirect: "error" },
	);
	expect(base).toHaveBeenCalledWith("https://mcp.example/", {
		method: "POST",
		redirect: "manual",
	});
	expect(response.ok).toBe(false);
});

it("leaves other requests unchanged", async () => {
	const base = vi.fn(async () => new Response("ok"));
	await redirectRefusingFetch(base as typeof fetch)("https://a.example/", {
		redirect: "follow",
	});
	expect(base).toHaveBeenCalledWith("https://a.example/", {
		redirect: "follow",
	});
});

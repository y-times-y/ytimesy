import { afterEach, expect, it, vi } from "vitest";
import { deleteAnalyticsPerson } from "./analytics-deletion";

afterEach(() => vi.unstubAllEnvs());

it("deletes the person with their events and recordings on the app host", async () => {
	vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
	vi.stubEnv("POSTHOG_PROJECT_ID", "42");
	vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
	const fetcher = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(null, { status: 202 }),
	);
	expect(await deleteAnalyticsPerson("alice", fetcher as never)).toBe(true);
	const [url, init] = fetcher.mock.calls[0];
	expect(url).toBe(
		"https://us.posthog.com/api/projects/42/persons/bulk_delete/",
	);
	expect(new Headers(init?.headers).get("authorization")).toBe(
		"Bearer phx_test",
	);
	expect(JSON.parse(String(init?.body))).toEqual({
		distinct_ids: ["alice"],
		delete_events: true,
		delete_recordings: true,
	});
});

it("reports an unconfigured key and throws on a refused deletion", async () => {
	vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "");
	expect(await deleteAnalyticsPerson("alice", vi.fn() as never)).toBe(false);
	vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
	vi.stubEnv("POSTHOG_PROJECT_ID", "42");
	await expect(
		deleteAnalyticsPerson(
			"alice",
			(async () => new Response(null, { status: 403 })) as never,
		),
	).rejects.toThrow("403");
});

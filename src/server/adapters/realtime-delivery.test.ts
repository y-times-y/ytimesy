import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "#/domain/conversation-delivery";
import { subscribeConversationSnapshot } from "./realtime-delivery";

const fetches = vi.hoisted(() => vi.fn());
vi.mock("./executor-fetch", () => ({ executorFetch: fetches }));

const sessionId = "00000000-0000-4000-8000-000000000009";
const snapshot = {
	userId: "alice",
	sessionId,
	revision: "5",
	progress: { sessionId, turnStatus: "running", items: [] },
} as unknown as ConversationSnapshot;
const call = (index: number) => {
	const [url, init] = fetches.mock.calls[index] as [string, RequestInit?];
	return { path: new URL(url).pathname, method: init?.method ?? "GET" };
};

beforeEach(() => {
	vi.stubEnv("YTIMESY_REALTIME_URL", "https://realtime.test");
	vi.stubEnv("YTIMESY_REALTIME_SECRET", "s".repeat(40));
	fetches.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("subscribes with the chat's snapshot in one round trip", async () => {
	fetches.mockResolvedValueOnce(new Response("stream", { status: 200 }));
	const response = await subscribeConversationSnapshot(
		snapshot,
		new AbortController().signal,
	);
	expect(response?.status).toBe(200);
	expect(fetches).toHaveBeenCalledOnce();
	expect(call(0)).toEqual({ path: "/stream", method: "POST" });
	expect(JSON.parse(fetches.mock.calls[0][1].body)).toEqual(snapshot);
});

it("falls back to subscribe, publish and resubscribe on an executor that predates it", async () => {
	fetches
		.mockResolvedValueOnce(new Response(null, { status: 404 }))
		.mockResolvedValueOnce(new Response(null, { status: 404 }))
		.mockResolvedValueOnce(new Response(null, { status: 204 }))
		.mockResolvedValueOnce(new Response("stream", { status: 200 }));
	const response = await subscribeConversationSnapshot(
		snapshot,
		new AbortController().signal,
	);
	expect(response?.status).toBe(200);
	expect([0, 1, 2, 3].map(call)).toEqual([
		{ path: "/stream", method: "POST" },
		{ path: "/stream", method: "GET" },
		{ path: "/snapshot", method: "POST" },
		{ path: "/stream", method: "GET" },
	]);
});

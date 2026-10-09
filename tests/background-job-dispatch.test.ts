import { afterEach, expect, it, vi } from "vitest";
import { backgroundJob } from "../src/domain/background-job";
import {
	backgroundJobId,
	dispatchBackgroundJob,
	withBackgroundJobDispatcher,
} from "../src/server/adapters/background-job-dispatch";

const job = {
	id: "00000000-0000-4000-8000-000000000001",
	kind: "work-plan" as const,
};
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("uses an invocation binding without a public request or queue", async () => {
	const dispatch = vi.fn(async () => {});
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	expect(
		await withBackgroundJobDispatcher(dispatch, () =>
			dispatchBackgroundJob(job),
		),
	).toBe(true);
	expect(dispatch).toHaveBeenCalledWith(job);
	expect(fetcher).not.toHaveBeenCalled();
});
it("keeps the same identity on a lost admission response", async () => {
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_URL", "https://development.example/");
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_SECRET", "test-secret".repeat(4));
	const bodies: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			bodies.push(init.body);
			if (bodies.length === 1) throw new Error("lost response");
			return new Response(null, { status: 202 });
		}),
	);
	expect(await dispatchBackgroundJob(job)).toBe(true);
	expect(bodies).toHaveLength(2);
	expect(bodies[0]).toBe(bodies[1]);
});
it("does not silently fallback to Node after rejected edge admission", async () => {
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_URL", "https://development.example/");
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_SECRET", "test-secret".repeat(4));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 503 })),
	);
	await expect(dispatchBackgroundJob(job)).rejects.toThrow("uncertain");
});
it("allows the legacy queue only when cutover is unset", async () => {
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_URL", "");
	expect(await dispatchBackgroundJob(job)).toBe(false);
});
it("rejects extra fields, invalid identities and oversized peer payloads", () => {
	expect(backgroundJob.safeParse({ ...job, token: "secret" }).success).toBe(
		false,
	);
	expect(backgroundJob.safeParse({ ...job, id: "bad" }).success).toBe(false);
	expect(
		backgroundJob.safeParse({
			...job,
			kind: "peer-message",
			userId: "u",
			senderId: "s",
			recipientId: "r",
			message: "a".repeat(8001),
		}).success,
	).toBe(false);
});
it("maps peer idempotency keys to bounded deterministic job IDs", () => {
	const id = backgroundJobId("sender:request");
	expect(id).toBe(backgroundJobId("sender:request"));
	expect(id).not.toBe(backgroundJobId("other:request"));
	expect(backgroundJob.safeParse({ ...job, id }).success).toBe(true);
});

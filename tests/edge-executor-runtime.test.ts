import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { unstable_dev } from "wrangler";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

let worker: Awaited<ReturnType<typeof unstable_dev>>;
const secret = "local-only-edge-test-secret".repeat(3);
const ingressSecret = "local-only-repair-ingress-secret".repeat(2);

beforeAll(async () => {
	worker = await unstable_dev(".ytimesy/edge-executor.mjs", {
		config: "wrangler.edge-executor.jsonc",
		local: true,
		vars: {
			DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
			MODEL_WORKFLOW_SECRET: secret,
			BACKGROUND_WORKFLOW_SECRET: secret,
			BACKGROUND_EXECUTION_ENABLED: "1",
			YTIMESY_REALTIME_SECRET: secret,
			PR_REPAIR_INGRESS_SECRET: ingressSecret,
		},
		logLevel: "error",
		experimental: { disableExperimentalWarning: true },
	});
	// The first request pays workerd's module load (about 5 s); warm it here so
	// no test's own timeout is charged for start-up.
	await worker.fetch("http://localhost/jobs/start", {
		method: "POST",
		body: "{}",
	});
}, 60_000);

afterAll(async () => {
	await worker?.stop();
});

it("rejects unsigned background jobs before admitting any job", async () => {
	expect(
		(
			await worker.fetch("http://localhost/jobs/start", {
				method: "POST",
				body: "{}",
			})
		).status,
	).toBe(401);
});

it("rejects malformed signed jobs and disabled environment launches", async () => {
	const url = "http://localhost/jobs/start";
	for (const [body, status] of [
		[JSON.stringify({ id: "bad", kind: "pr-repair" }), 400],
		[
			JSON.stringify({
				id: "00000000-0000-4000-8000-000000000001",
				kind: "prepare",
				workspaceId: "workspace",
				repairModel: null,
			}),
			503,
		],
	] as const) {
		expect(
			(
				await worker.fetch(url, {
					method: "POST",
					body,
					headers: await signDeliveryRequest(secret, "POST", url, body),
				})
			).status,
		).toBe(status);
	}
});

it("refuses authenticated execution while cutover is disabled, without touching the database", async () => {
	const url = "http://localhost/model-step";
	const body = JSON.stringify({
		turnId: "00000000-0000-4000-8000-000000000001",
		leaseId: "00000000-0000-4000-8000-000000000002",
		index: 1,
	});
	expect(
		(
			await worker.fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", url, body),
			})
		).status,
	).toBe(503);
});

it("loads the real harness bundle in workerd and rejects unsigned calls before database access", async () => {
	expect(
		(
			await worker.fetch("http://localhost/model-step", {
				method: "POST",
				body: "{}",
			})
		).status,
	).toBe(401);
});

it("accepts only repair intake signed with the ingress key and keeps it disabled until enabled", async () => {
	const url = "http://localhost/pr-repair-event";
	const body = "{}";
	expect((await worker.fetch(url, { method: "POST", body })).status).toBe(401);
	// The model workflow key no longer opens repair intake.
	expect(
		(
			await worker.fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", url, body),
			})
		).status,
	).toBe(401);
	expect(
		(
			await worker.fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(ingressSecret, "POST", url, body),
			})
		).status,
	).toBe(503);
});

it("does not accept the repair ingress key for model steps", async () => {
	const url = "http://localhost/model-step";
	const body = "{}";
	expect(
		(
			await worker.fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(ingressSecret, "POST", url, body),
			})
		).status,
	).toBe(401);
});

it("does not admit a chat turn while development cutover is disabled", async () => {
	const url = "http://localhost/start";
	const body = JSON.stringify({
		turnId: "00000000-0000-4000-8000-000000000001",
		leaseId: "00000000-0000-4000-8000-000000000002",
	});
	expect(
		(
			await worker.fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", url, body),
			})
		).status,
	).toBe(503);
});

it("owns realtime snapshots and cancellation in the model chat DO without accessing PG", async () => {
	const sessionId = randomUUID();
	const snapshotUrl = "http://localhost/snapshot";
	const body = JSON.stringify({
		userId: "edge-alice",
		sessionId,
		revision: "2",
		progress: {
			sessionId,
			turnStatus: "running",
			items: [{ kind: "agentMessage", id: "a", text: "Unified chat state" }],
		},
	});
	expect(
		(
			await worker.fetch(snapshotUrl, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", snapshotUrl, body),
			})
		).status,
	).toBe(204);
	const streamUrl = `http://localhost/stream?userId=edge-alice&sessionId=${sessionId}`;
	const streamed = await worker.fetch(streamUrl, {
		headers: await signDeliveryRequest(secret, "GET", streamUrl),
	});
	expect(streamed.status).toBe(200);
	const reader = streamed.body?.getReader();
	if (!reader) throw new Error("Missing chat stream.");
	// An event can arrive split across chunks: read until the snapshot shows.
	const decoder = new TextDecoder();
	let received = "";
	const until = Date.now() + 5_000;
	while (!received.includes("Unified chat state") && Date.now() < until) {
		const { value, done } = await reader.read();
		if (done) break;
		received += decoder.decode(value, { stream: true });
	}
	expect(received).toContain("Unified chat state");
	await reader.cancel();
	const turn = {
		userId: "edge-alice",
		sessionId,
		turnId: randomUUID(),
		leaseId: randomUUID(),
	};
	for (const [action, status] of [
		["acquire", 204],
		["renew", 204],
		["cancel", 204],
		["renew", 409],
		["release", 204],
		["acquire", 409],
	] as const) {
		const url = `http://localhost/turn/${action}`;
		const controlBody = JSON.stringify(turn);
		expect(
			(
				await worker.fetch(url, {
					method: "POST",
					body: controlBody,
					headers: await signDeliveryRequest(secret, "POST", url, controlBody),
				})
			).status,
		).toBe(status);
	}
	const foreignUrl = streamUrl.replace("edge-alice", "edge-bob");
	expect(
		(
			await worker.fetch(foreignUrl, {
				headers: await signDeliveryRequest(secret, "GET", foreignUrl),
			})
		).status,
	).toBe(404);
});

it("purges a chat object's stored state on a signed request, idempotently", async () => {
	const sessionId = randomUUID();
	const snapshotUrl = "http://localhost/snapshot";
	const body = JSON.stringify({
		userId: "edge-carol",
		sessionId,
		revision: "1",
		progress: { sessionId, turnStatus: "idle", items: [] },
	});
	expect(
		(
			await worker.fetch(snapshotUrl, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(secret, "POST", snapshotUrl, body),
			})
		).status,
	).toBe(204);
	const purgeUrl = "http://localhost/purge";
	const purge = JSON.stringify({ userId: "edge-carol", sessionId });
	expect(
		(await worker.fetch(purgeUrl, { method: "POST", body: purge })).status,
	).toBe(401);
	for (let attempt = 0; attempt < 2; attempt++)
		expect(
			(
				await worker.fetch(purgeUrl, {
					method: "POST",
					body: purge,
					headers: await signDeliveryRequest(secret, "POST", purgeUrl, purge),
				})
			).status,
		).toBe(204);
	// The tombstone refuses a write an in-flight turn still makes.
	const later = body.replace('"revision":"1"', '"revision":"2"');
	expect(
		(
			await worker.fetch(snapshotUrl, {
				method: "POST",
				body: later,
				headers: await signDeliveryRequest(secret, "POST", snapshotUrl, later),
			})
		).status,
	).toBe(410);
});

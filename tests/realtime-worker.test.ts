import { createParser, type EventSourceMessage } from "eventsource-parser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { unstable_dev } from "wrangler";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

const secret = "test-delivery-key".repeat(4);
const sessionId = "00000000-0000-4000-8000-000000000001";
const turn = {
	userId: "alice",
	sessionId,
	turnId: randomUUID(),
	leaseId: randomUUID(),
};
let worker: Awaited<ReturnType<typeof unstable_dev>>;
let persistence: string;
beforeAll(async () => {
	persistence = await mkdtemp(join(tmpdir(), "ytimesy-realtime-test-"));
	worker = await startWorker();
}, 30_000);
async function startWorker() {
	return unstable_dev("src/realtime/worker.ts", {
		config: "wrangler.realtime.jsonc",
		vars: { DELIVERY_SECRET: secret },
		experimental: { disableExperimentalWarning: true },
		local: true,
		persist: true,
		persistTo: persistence,
		logLevel: "error",
	});
}
afterAll(async () => {
	await worker?.stop();
	if (persistence) await rm(persistence, { recursive: true });
});
async function publish(
	revision: string,
	text: string,
	userId = "alice",
	targetSessionId = sessionId,
) {
	const body = JSON.stringify({
		userId,
		sessionId: targetSessionId,
		revision,
		progress: {
			sessionId: targetSessionId,
			turnStatus: "running",
			items: [{ kind: "agentMessage", id: "a", text }],
		},
	});
	const url = "http://localhost/snapshot";
	return worker.fetch(url, {
		method: "POST",
		headers: await signDeliveryRequest(secret, "POST", url, body),
		body,
	});
}
async function control(action: string, input = turn) {
	const url = `http://localhost/turn/${action}`;
	const body = JSON.stringify(input);
	return worker.fetch(url, {
		method: "POST",
		body,
		headers: await signDeliveryRequest(secret, "POST", url, body),
	});
}
it("requires signed ingress and delivers the newest durable snapshot after reconnect", async () => {
	expect(
		(
			await worker.fetch("http://localhost/snapshot", {
				method: "POST",
				body: "{}",
			})
		).status,
	).toBe(401);
	expect((await publish("2", "new")).status).toBe(204);
	expect((await publish("1", "stale")).status).toBe(204);
	const url = `http://localhost/stream?userId=alice&sessionId=${sessionId}`;
	const response = await worker.fetch(url, {
		headers: await signDeliveryRequest(secret, "GET", url),
	});
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	let event: EventSourceMessage | undefined;
	const decoder = new TextDecoder();
	const parser = createParser({
		onEvent: (value) => {
			event = value;
		},
	});
	while (!event) {
		const part = await reader.read();
		if (part.done) throw new Error("Stream ended before its first event");
		parser.feed(decoder.decode(part.value, { stream: true }));
	}
	expect(event.data).toContain('"text":"new"');
	expect(event.id).toBe("2");
	await reader.cancel();
	const crossOwnerUrl = url.replace("alice", "bob");
	expect(
		(
			await worker.fetch(crossOwnerUrl, {
				headers: await signDeliveryRequest(secret, "GET", crossOwnerUrl),
			})
		).status,
	).toBe(404);
}, 20_000);

it("restores a chunked snapshot after a complete local worker restart", async () => {
	const text = "durable-content-".repeat(170_000);
	expect((await publish("3", text)).status).toBe(204);
	expect((await control("acquire")).status).toBe(204);
	await worker.stop();
	worker = await startWorker();
	expect((await control("renew")).status).toBe(204);
	const url = `http://localhost/stream?userId=alice&sessionId=${sessionId}&revision=3`;
	const response = await worker.fetch(url, {
		headers: await signDeliveryRequest(secret, "GET", url),
	});
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing restored stream");
	let received = "";
	const decoder = new TextDecoder();
	while (!received.includes("\n\n")) {
		const frame = await reader.read();
		if (frame.done) throw new Error("Restored stream ended prematurely");
		received += decoder.decode(frame.value, { stream: true });
	}
	expect(received).toContain("id: 3");
	expect(received).toContain(text);
	await reader.cancel();
}, 30_000);

it("streams large changing snapshots to sixteen viewers without resetting the room", async () => {
	const stressSessionId = "00000000-0000-4000-8000-000000000099";
	expect((await publish("100", "seed", "alice", stressSessionId)).status).toBe(
		204,
	);
	const url = `http://localhost/stream?userId=alice&sessionId=${stressSessionId}`;
	const readers = await Promise.all(
		Array.from({ length: 16 }, async () => {
			const response = await worker.fetch(url, {
				headers: await signDeliveryRequest(secret, "GET", url),
			});
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing stream");
			const frames: { id: string | undefined; bytes: number }[] = [];
			const decoder = new TextDecoder();
			const parser = createParser({
				onEvent: (event) =>
					frames.push({ id: event.id, bytes: Buffer.byteLength(event.data) }),
			});
			const next = async () => {
				while (!frames.length) {
					const part = await reader.read();
					if (part.done)
						throw new Error("Stream closed before the next revision");
					parser.feed(decoder.decode(part.value, { stream: true }));
				}
				return frames.shift();
			};
			expect((await next())?.id).toBe("100");
			return { reader, next };
		}),
	);
	try {
		const text = "shared-frame-".repeat(170_000);
		for (let revision = 101; revision <= 108; revision++) {
			const reading = Promise.allSettled(
				readers.map(async ({ next }) => {
					const frame = await next();
					expect(frame?.id).toBe(String(revision));
					expect(frame?.bytes).toBeGreaterThan(2_000_000);
				}),
			);
			expect(
				(
					await publish(
						String(revision),
						`${text}${revision}`,
						"alice",
						stressSessionId,
					)
				).status,
			).toBe(204);
			for (const result of await reading)
				if (result.status === "rejected") throw result.reason;
		}
	} finally {
		await Promise.all(readers.map(({ reader }) => reader.cancel()));
	}
}, 60_000);

it("fences duplicate workers, cancelled renewals, retired replay and stale cancellation", async () => {
	const another = { ...turn, turnId: randomUUID(), leaseId: randomUUID() };
	expect((await control("acquire", another)).status).toBe(409);
	expect(
		(await control("renew", { ...turn, leaseId: randomUUID() })).status,
	).toBe(409);
	expect((await control("cancel")).status).toBe(204);
	expect((await control("renew")).status).toBe(409);
	expect((await control("release")).status).toBe(204);
	expect((await control("acquire")).status).toBe(409);
	expect((await control("acquire", another)).status).toBe(204);
	expect((await control("cancel")).status).toBe(409);
	expect((await control("renew", another)).status).toBe(204);
	expect((await control("release", another)).status).toBe(204);
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { startEvaluationCoordinator } from "../benchmarks/evaluation/coordination";
import { apiTurnFailureClassification } from "../src/domain/api-turn-failure";
import { TURN_COORDINATION_LEASE_MS } from "../src/domain/conversation-turn-control";
import { coordinateConversationTurn } from "../src/server/adapters/conversation-turn-control";

it("isolates evaluation leases and preserves fencing across parent continuation and failures", async () => {
	const inherited = {
		url: process.env.YTIMESY_REALTIME_URL,
		secret: process.env.YTIMESY_REALTIME_SECRET,
	};
	process.env.YTIMESY_REALTIME_URL = "https://shared-coordinator.invalid";
	process.env.YTIMESY_REALTIME_SECRET = "shared-secret".repeat(4);
	const fetcher = globalThis.fetch;
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(String(input));
			return fetcher(input, init);
		},
	);
	let coordinator:
		| Awaited<ReturnType<typeof startEvaluationCoordinator>>
		| undefined;
	try {
		coordinator = await startEvaluationCoordinator();
		expect(coordinator.preflight).toMatchObject({ local: true, renew: true });
		const parent = {
			userId: "test-owner",
			sessionId: randomUUID(),
			turnId: randomUUID(),
			leaseId: randomUUID(),
		};
		const child = {
			...parent,
			sessionId: randomUUID(),
			turnId: randomUUID(),
			leaseId: randomUUID(),
		};
		expect(await coordinateConversationTurn("acquire", parent)).toBe(true);
		expect(await coordinateConversationTurn("acquire", child)).toBe(true);
		expect(
			await coordinateConversationTurn("acquire", {
				...parent,
				turnId: randomUUID(),
				leaseId: randomUUID(),
			}),
		).toBe(false);
		expect(await coordinateConversationTurn("release", parent)).toBe(true);
		const resumed = { ...parent, turnId: randomUUID(), leaseId: randomUUID() };
		expect(await coordinateConversationTurn("acquire", resumed)).toBe(true);
		expect(await coordinateConversationTurn("renew", parent)).toBe(false);
		expect(await coordinateConversationTurn("renew", child)).toBe(true);
		const correctSecret = process.env.YTIMESY_REALTIME_SECRET;
		process.env.YTIMESY_REALTIME_SECRET = "incorrect-signature".repeat(4);
		const rejected = await coordinateConversationTurn("renew", resumed).catch(
			(error) => error,
		);
		expect(apiTurnFailureClassification(rejected)).toMatchObject({
			action: "renew",
			attempts: 1,
			failure: { kind: "http", status: 401 },
		});
		process.env.YTIMESY_REALTIME_SECRET = correctSecret;
		expect(await coordinateConversationTurn("renew", resumed)).toBe(true);
		expect(await coordinateConversationTurn("cancel", resumed)).toBe(true);
		expect(await coordinateConversationTurn("renew", resumed)).toBe(false);
		await coordinateConversationTurn("release", resumed);
		await coordinateConversationTurn("release", child);
		expect(
			requests.some((url) => url.includes("shared-coordinator.invalid")),
		).toBe(false);
		await coordinator.close();
		expect(process.env.YTIMESY_REALTIME_URL).toBe(
			"https://shared-coordinator.invalid",
		);
	} finally {
		await coordinator?.close();
		vi.unstubAllGlobals();
		for (const [name, value] of Object.entries({
			YTIMESY_REALTIME_URL: inherited.url,
			YTIMESY_REALTIME_SECRET: inherited.secret,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}, 30_000);

it(
	"rejects an expired lease without replaying the retired writer",
	async () => {
		const coordinator = await startEvaluationCoordinator();
		try {
			const turn = {
				userId: "expiration-control",
				sessionId: randomUUID(),
				turnId: randomUUID(),
				leaseId: randomUUID(),
			};
			expect(await coordinateConversationTurn("acquire", turn)).toBe(true);
			await delay(TURN_COORDINATION_LEASE_MS + 1_000);
			expect(await coordinateConversationTurn("renew", turn)).toBe(false);
			expect(await coordinateConversationTurn("acquire", turn)).toBe(false);
			const replacement = {
				...turn,
				turnId: randomUUID(),
				leaseId: randomUUID(),
			};
			expect(await coordinateConversationTurn("acquire", replacement)).toBe(
				true,
			);
			expect(await coordinateConversationTurn("cancel", turn)).toBe(false);
			expect(await coordinateConversationTurn("renew", replacement)).toBe(true);
			await coordinateConversationTurn("release", replacement);
		} finally {
			await coordinator.close();
		}
	},
	TURN_COORDINATION_LEASE_MS + 15_000,
);

it("fails coordinator preflight closed and restores inherited configuration", async () => {
	const previousUrl = process.env.YTIMESY_REALTIME_URL;
	const previousSecret = process.env.YTIMESY_REALTIME_SECRET;
	const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
	vi.stubGlobal("fetch", fetcher);
	try {
		await expect(startEvaluationCoordinator()).rejects.toMatchObject({
			name: "CoordinationFailure",
			action: "acquire",
			attempts: 1,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(process.env.YTIMESY_REALTIME_URL).toBe(previousUrl);
		expect(process.env.YTIMESY_REALTIME_SECRET).toBe(previousSecret);
	} finally {
		vi.unstubAllGlobals();
	}
}, 30_000);

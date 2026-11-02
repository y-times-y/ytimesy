import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grokPlanUsageForPicker } from "./xai-plan-usage";
import { saveXaiSubscription } from "./xai-subscription";

const holder = vi.hoisted(() => {
	process.env.BETTER_AUTH_SECRET = "b".repeat(40);
	process.env.TOKEN_VAULT_KEY = "v".repeat(40);
	return { query: vi.fn() };
});
vi.mock("../adapters/database", () => ({ database: () => holder }));

const accessToken = "xai-access-token-abcdefghijklmnopqrstuvwxyz";
let db: PGlite;

const billing = (percent: number) => ({
	config: {
		currentPeriod: {
			type: "USAGE_PERIOD_TYPE_WEEKLY",
			start: "2026-10-27T17:39:52.407040+00:00",
			end: "2999-11-03T17:39:52.407040+00:00",
		},
		creditUsagePercent: percent,
	},
});
const answering = (status: number, body: unknown = {}) =>
	vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify(body), { status }),
	);
const percents = (usage: Awaited<ReturnType<typeof grokPlanUsageForPicker>>) =>
	usage?.windows.map((window) => window.usedPercent);

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
	 create table model_connection(id text primary key,user_id text not null,provider text,
	   label text,base_url text,sealed_credential text,models jsonb,revision text,
	   kind text not null default 'key',status text not null default 'ready',
	   updated_at timestamptz not null default now(),plan_usage jsonb,plan_usage_at timestamptz);`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
	await saveXaiSubscription(
		holder,
		"u1",
		{ access_token: accessToken, refresh_token: "r", expires_in: 3600 },
		[],
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await db.close();
});

describe("reads the Grok plan's usage for the picker", () => {
	it("sends one GET with the user's token and saves the reading", async () => {
		const fetch = answering(200, billing(10));
		expect(percents(await grokPlanUsageForPicker("u1", { fetch }))).toEqual([
			10,
		]);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		);
		expect(init?.method).toBeUndefined();
		expect(new Headers(init?.headers).get("authorization")).toBe(
			`Bearer ${accessToken}`,
		);
		const stored = (
			await db.query<{ plan_usage: { windows: unknown[] } }>(
				"select plan_usage from model_connection",
			)
		).rows[0];
		expect(stored?.plan_usage.windows).toHaveLength(1);
	});

	it("sends at most one request per five minutes, however often it opens", async () => {
		const fetch = answering(200, billing(10));
		await grokPlanUsageForPicker("u1", { fetch });
		const again = answering(200, billing(50));
		expect(
			percents(await grokPlanUsageForPicker("u1", { fetch: again })),
		).toEqual([10]);
		expect(again).not.toHaveBeenCalled();
		await db.query(
			"update model_connection set plan_usage_at=now()-interval '6 minutes'",
		);
		expect(
			percents(await grokPlanUsageForPicker("u1", { fetch: again })),
		).toEqual([50]);
		expect(again).toHaveBeenCalledTimes(1);
	});

	it("shares one request between opens that arrive together", async () => {
		let answer: (response: Response) => void = () => {};
		const pending = vi.fn<typeof fetch>(
			() => new Promise((resolve) => (answer = resolve)),
		);
		const first = grokPlanUsageForPicker("u1", { fetch: pending });
		const second = grokPlanUsageForPicker("u1", { fetch: pending });
		expect(second).toBe(first);
		await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
		answer(new Response(JSON.stringify(billing(20)), { status: 200 }));
		expect(percents(await second)).toEqual([20]);
	});

	it("keeps the last reading on failure, never marks the connection, and waits five minutes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await grokPlanUsageForPicker("u1", { fetch: answering(200, billing(30)) });
		for (const failing of [
			answering(401),
			answering(200, { config: {} }),
			vi.fn<typeof fetch>(async () => {
				throw new TypeError("network");
			}),
		]) {
			await db.query(
				"update model_connection set plan_usage_at=now()-interval '6 minutes'",
			);
			expect(
				percents(await grokPlanUsageForPicker("u1", { fetch: failing })),
			).toEqual([30]);
			const next = answering(200, billing(90));
			expect(
				percents(await grokPlanUsageForPicker("u1", { fetch: next })),
			).toEqual([30]);
			expect(next).not.toHaveBeenCalled();
		}
		const row = (
			await db.query<{ status: string }>("select status from model_connection")
		).rows[0];
		expect(row?.status).toBe("ready");
		expect(JSON.stringify(warn.mock.calls)).not.toContain(accessToken);
	});

	it("gives up after a short timeout", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const hanging = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
		);
		expect(
			await grokPlanUsageForPicker("u1", { fetch: hanging, timeoutMs: 10 }),
		).toBeNull();
	});

	it("sends nothing while the plan needs a new sign-in, and a reconnect drops the reading", async () => {
		await grokPlanUsageForPicker("u1", { fetch: answering(200, billing(30)) });
		await db.query(
			"update model_connection set status='reconnect',plan_usage_at=null",
		);
		const fetch = answering(200, billing(40));
		expect(await grokPlanUsageForPicker("u1", { fetch })).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		await saveXaiSubscription(
			holder,
			"u1",
			{ access_token: accessToken, refresh_token: "r", expires_in: 3600 },
			[],
		);
		const row = (
			await db.query<{ plan_usage: unknown; status: string }>(
				"select plan_usage,status from model_connection",
			)
		).rows[0];
		expect(row).toEqual({ plan_usage: null, status: "ready" });
	});
});

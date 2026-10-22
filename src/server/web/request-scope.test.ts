import { expect, it, vi } from "vitest";
import { startAfterResponse } from "../adapters/after-response";
import type { WebWorkerEnvironment } from "./environment";
import { withWebRequestScope } from "./request-scope";

const { passThrough } = vi.hoisted(() => ({
	passThrough: (...args: unknown[]) =>
		// The callback to run: the last function argument (others are bindings).
		(args.filter((arg) => typeof arg === "function").at(-1) as () => unknown)(),
}));
vi.mock("../adapters/database-scope", () => ({
	withDatabaseScope: passThrough,
}));
vi.mock("../adapters/codex-subscription-transport", () => ({
	withCodexSubscriptionEgress: passThrough,
}));
vi.mock("../adapters/executor-fetch", () => ({
	withExecutorBinding: passThrough,
}));
vi.mock("../edge/model-endpoint", () => ({
	withEdgeModelEndpoints: passThrough,
}));

it("responds before work started for after the response, and holds the request open until it settled", async () => {
	let finish = () => {};
	const after = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let held: Promise<unknown> | undefined;
	const env = {
		HYPERDRIVE: { connectionString: "postgres://local" },
	} as unknown as WebWorkerEnvironment;
	const response = await withWebRequestScope(
		env,
		(work) => {
			held = work;
		},
		async () => {
			expect(startAfterResponse(() => after)).toBe(true);
			return new Response(null, { status: 204 });
		},
	);
	expect(response.status).toBe(204);
	let settled = false;
	void held?.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(settled).toBe(false);
	finish();
	await held;
	expect(settled).toBe(true);
});

it("has no after-response scope outside a web request", () => {
	expect(startAfterResponse(async () => {})).toBe(false);
});

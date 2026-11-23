import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurnRunnerBox } from "./box-runner";
import type { TurnBoxEdgeClient } from "./turn-box-client";

/**
 * A box on an old program upgrades itself without cutting a turn
 * (box-runner.ts): told a newer version is published, it takes no new turn,
 * waits for the ones it holds (and a claim in flight), then restarts.
 */
const ENV = {
	YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
	YTIMESY_BUILD_ID: "old-version",
	YTIMESY_TURN_BOX_POLL_MS: "1000",
};

function fakeClient(latest: string | null) {
	const state = {
		claims: 0,
		pendingClaim: null as null | ((value: null) => void),
		holdClaims: false,
	};
	const client = {
		latestVersion: null as string | null,
		register: vi.fn(async () => {
			client.latestVersion = latest;
			return true;
		}),
		claim: vi.fn(async () => {
			state.claims++;
			if (state.holdClaims)
				return new Promise<null>((resolve) => {
					state.pendingClaim = resolve;
				});
			return null;
		}),
	};
	return { client: client as unknown as TurnBoxEdgeClient, state };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a box upgrading itself", () => {
	it("stops claiming and restarts once nothing runs when a newer program is published", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const { client, state } = fakeClient("new-version");
		const ready = vi.fn();
		const box = await runTurnRunnerBox({
			env: ENV,
			client,
			signalHandlers: false,
			onUpgradeReady: ready,
		});
		const claimsAtStart = state.claims;
		await vi.advanceTimersByTimeAsync(10_000);
		// The first registration already said: no new turns.
		expect(state.claims).toBe(claimsAtStart);
		expect(ready).toHaveBeenCalledOnce();
		await box.stop?.().catch(() => undefined);
	});

	it("waits for a claim in flight before restarting", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const { client, state } = fakeClient(null);
		state.holdClaims = true;
		const ready = vi.fn();
		await runTurnRunnerBox({
			env: ENV,
			client,
			signalHandlers: false,
			onUpgradeReady: ready,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(state.pendingClaim).not.toBeNull();
		// Now a new program is published.
		(
			client as unknown as { register: ReturnType<typeof vi.fn> }
		).register.mockImplementation(async () => {
			(client as { latestVersion: string | null }).latestVersion =
				"new-version";
			return true;
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ready).not.toHaveBeenCalled();
		state.pendingClaim?.(null);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(ready).toHaveBeenCalledOnce();
	});

	it("stays when it already runs the published program", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const { client } = fakeClient("old-version");
		const ready = vi.fn();
		await runTurnRunnerBox({
			env: ENV,
			client,
			signalHandlers: false,
			onUpgradeReady: ready,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ready).not.toHaveBeenCalled();
	});
});

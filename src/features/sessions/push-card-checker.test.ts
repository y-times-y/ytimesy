import { describe, expect, it, vi } from "vitest";
import type { PushCardState } from "#/domain/push-approval";
import {
	createPushCardChecker,
	PUSH_CARD_RECHECK_MS,
} from "./push-card-checker";

function setup(options: { visible?: () => boolean } = {}) {
	let answer: PushCardState = { answer: "pending" };
	const states: PushCardState[] = [];
	const checking: boolean[] = [];
	let tick: (() => void) | null = null;
	const timers = {
		repeat: vi.fn((run: () => void, ms: number) => {
			expect(ms).toBe(PUSH_CARD_RECHECK_MS);
			tick = run;
			return "handle";
		}),
		clear: vi.fn(),
	};
	const status = vi.fn(async () => answer);
	const checker = createPushCardChecker({
		status,
		onState: (state) => states.push(state),
		onChecking: (value) => checking.push(value),
		visible: options.visible ?? (() => true),
		timers,
	});
	return {
		checker,
		status,
		states,
		checking,
		timers,
		set: (next: PushCardState) => {
			answer = next;
		},
		tick: () => tick?.(),
	};
}

describe("a pending push card's re-checks", () => {
	it("checks when shown, then flips to Outdated when the chat grows, and stops polling", async () => {
		const t = setup();
		await t.checker.start();
		expect(t.states).toEqual([{ answer: "pending" }]);
		// The chat gains items after the card (a later turn committed).
		t.set({ answer: "outdated", detail: "the branch has newer commits" });
		await t.checker.check();
		expect(t.states.at(-1)).toEqual({
			answer: "outdated",
			detail: "the branch has newer commits",
		});
		expect(t.timers.clear).toHaveBeenCalledWith("handle");
		// Settled: neither the interval nor a later change asks again.
		const calls = t.status.mock.calls.length;
		t.tick();
		await t.checker.check();
		expect(t.status).toHaveBeenCalledTimes(calls);
	});

	it("re-checks on the slow interval only while the tab is visible", async () => {
		let visible = false;
		const t = setup({ visible: () => visible });
		await t.checker.start();
		t.tick();
		await Promise.resolve();
		expect(t.status).toHaveBeenCalledTimes(1);
		visible = true;
		t.set({ answer: "expired", detail: "" });
		t.tick();
		await vi.waitFor(() =>
			expect(t.states.at(-1)).toMatchObject({ answer: "expired" }),
		);
	});

	it("runs one call at a time, asks once more for a change that arrived during it, and marks it in flight", async () => {
		let release: (state: PushCardState) => void = () => {};
		const status = vi
			.fn<() => Promise<PushCardState>>()
			.mockImplementationOnce(
				() => new Promise((resolve) => (release = resolve)),
			)
			.mockResolvedValue({ answer: "pushed", detail: "abc1234" });
		const checking: boolean[] = [];
		const states: PushCardState[] = [];
		const checker = createPushCardChecker({
			status,
			onState: (state) => states.push(state),
			onChecking: (value) => checking.push(value),
			visible: () => true,
			timers: { repeat: () => "h", clear: () => {} },
		});
		const first = checker.start();
		void checker.check();
		void checker.check();
		expect(status).toHaveBeenCalledTimes(1);
		expect(checking).toEqual([true]);
		release({ answer: "pending" });
		await first;
		expect(status).toHaveBeenCalledTimes(2);
		expect(states).toEqual([
			{ answer: "pending" },
			{ answer: "pushed", detail: "abc1234" },
		]);
		expect(checking.at(-1)).toBe(false);
	});

	it("does not overwrite a clicked approval with an older background response", async () => {
		let resolveStatus: (state: PushCardState) => void = () => {};
		const onState = vi.fn();
		const checker = createPushCardChecker({
			status: () =>
				new Promise((resolve) => {
					resolveStatus = resolve;
				}),
			onState,
			visible: () => true,
			timers: { repeat: () => "handle", clear: () => {} },
		});
		const checking = checker.start();
		checker.settle();
		resolveStatus({ answer: "pending" });
		await checking;
		expect(onState).not.toHaveBeenCalled();
	});

	it("keeps going after a failed call and stops on demand", async () => {
		const t = setup();
		t.status.mockRejectedValueOnce(new Error("offline"));
		await t.checker.start();
		expect(t.states).toEqual([]);
		await t.checker.check();
		expect(t.states).toEqual([{ answer: "pending" }]);
		t.checker.settle();
		await t.checker.check();
		expect(t.status).toHaveBeenCalledTimes(2);
		t.checker.stop();
		expect(t.timers.clear).toHaveBeenCalled();
	});
});

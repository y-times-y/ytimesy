import { expect, it } from "vitest";
import {
	wakeConversationProgress,
	withConversationProgressWake,
} from "./conversation-progress-wake";
import { withInvocationTasks } from "./invocation-tasks";

it("relays beside the caller, coalesces wakes during a relay and finishes before the invocation ends", async () => {
	const relays: string[] = [];
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	await withInvocationTasks(() =>
		withConversationProgressWake(
			async () => {
				calls++;
				if (calls === 1) await blocked;
				relays.push(`relay-${calls}`);
			},
			async () => {
				await wakeConversationProgress();
				// The caller is not held by the slow relay.
				expect(relays).toEqual([]);
				await wakeConversationProgress();
				await wakeConversationProgress();
				release();
			},
		),
	);
	// One relay for the first wake, one more for the wakes made during it.
	expect(relays).toEqual(["relay-1", "relay-2"]);
});

it("never surfaces a relay failure to the turn", async () => {
	await withInvocationTasks(() =>
		withConversationProgressWake(
			async () => {
				throw new Error("room unavailable");
			},
			() => wakeConversationProgress(),
		),
	);
	await expect(wakeConversationProgress()).resolves.toBeUndefined();
});

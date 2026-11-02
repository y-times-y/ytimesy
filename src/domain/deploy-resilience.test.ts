import { expect, it } from "vitest";
import { machineFailureMessage } from "./api-turn-failure";
import {
	interruptedJobDecision,
	MAX_JOB_INTERRUPTIONS,
} from "./background-job";
import { progressReopenDelayMs } from "./session-progress";
import { silentReconnectDelayMs } from "./workspace-desktop";

const provisionError = (message: string) =>
	Object.assign(new Error(message), {
		name: "WorkspaceProvisionError",
		_tag: "WorkspaceProvisionError",
	});

it("replays an interrupted job only when its kind is safe to repeat, a few times", () => {
	expect(interruptedJobDecision("conversation-fork", 0)).toBe("replay");
	expect(interruptedJobDecision("prepare", MAX_JOB_INTERRUPTIONS - 1)).toBe(
		"replay",
	);
	expect(interruptedJobDecision("prepare", MAX_JOB_INTERRUPTIONS)).toBe("fail");
	// Not yet idempotent: these still fail closed.
	expect(interruptedJobDecision("held-sends", 0)).toBe("fail");
	expect(interruptedJobDecision("background-wake", 0)).toBe("fail");
});

it("reopens a refused progress stream quickly at first, capped at about 10 s", () => {
	const mid = () => 0.5;
	expect(progressReopenDelayMs(0, mid)).toBe(500);
	expect(progressReopenDelayMs(2, mid)).toBe(2_000);
	expect(progressReopenDelayMs(20, mid)).toBe(10_000);
});

it("reconnects a dropped live socket silently, unless the relay said why", () => {
	expect(silentReconnectDelayMs({ wasConnected: true, attempt: 0 })).toBe(500);
	expect(
		silentReconnectDelayMs({ wasConnected: true, reason: "", attempt: 1 }),
	).toBe(1_000);
	expect(
		silentReconnectDelayMs({ wasConnected: true, attempt: 99 }),
	).toBeNull();
	expect(
		silentReconnectDelayMs({
			wasConnected: true,
			reason: "Desktop is not ready.",
			attempt: 0,
		}),
	).toBeNull();
	expect(
		silentReconnectDelayMs({ wasConnected: false, attempt: 0 }),
	).toBeNull();
});

it("names the start failures that used to read as an unknown provider error", () => {
	for (const [raw, reason] of [
		[
			"An earlier start of this machine was still finishing.",
			"an earlier start of it was still finishing",
		],
		[
			"The machine provider is limiting requests right now.",
			"the machine provider was limiting requests",
		],
		[
			"Workspace sizing did not complete. The unbound machine needs recovery before it can be used.",
			"it did not finish resizing",
		],
		[
			"YTIMESY_USER_5H_MICRO_USD must be configured.",
			"this deployment is missing a machine setting",
		],
		[
			"The workspace machine is not responding. Try again in a minute.",
			"the machine provider was not responding",
		],
	] as const)
		expect(machineFailureMessage(provisionError(raw))).toBe(
			`The chat's machine could not start: ${reason}. Retry; your work is preserved.`,
		);
});

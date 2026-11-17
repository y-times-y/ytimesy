import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { planPeerInjection } from "./peer-inbox-injection";

const queued = (id: string, released: boolean | undefined) => ({
	id: `row-${id}`,
	message: `queued ${id}`,
	queued_send: {
		item: { kind: "userMessage" as const, id: SessionItemId(id), text: id },
		released,
	},
});

describe("planPeerInjection", () => {
	const history = [{ role: "user" as const, content: "hi" }];
	const options = { delivered: () => false, sentUserMessagesOnly: false };

	it("injects plain notices once, never one already in the history", () => {
		const rows = [
			{ id: "a", message: "hi", queued_send: null },
			{ id: "b", message: "news", queued_send: null },
		];
		const plan = planPeerInjection(rows, history, options);
		expect(plan.injected.map((m) => m.content)).toEqual(["hi", "news"]);
		expect(plan.delivering).toEqual(["a", "b"]);
	});

	it("keeps an unsent queued follow-up editable, and takes a released one", () => {
		const plan = planPeerInjection(
			[queued("q1", false), queued("q2", true)],
			history,
			options,
		);
		expect(plan.delivering).toEqual(["row-q2"]);
		expect(plan.users.map((item) => item.id)).toEqual(["q2"]);
	});

	it("takes only released queued messages for a Claude Code run's hooks", () => {
		const plan = planPeerInjection(
			[
				queued("q1", undefined),
				queued("q2", true),
				{ id: "n", message: "x", queued_send: null },
			],
			history,
			{ ...options, sentUserMessagesOnly: true },
		);
		expect(plan.delivering).toEqual(["row-q2"]);
	});

	it("reports the setup catch-up row but never injects it", () => {
		const plan = planPeerInjection(
			[{ id: "setup-catch-up:s", message: "ready", queued_send: null }],
			history,
			options,
		);
		expect(plan.catchUp).toBe(true);
		expect(plan.delivering).toEqual([]);
		expect(plan.injected).toEqual(history);
	});

	it("skips a queued message the timeline already shows but still accepts its row", () => {
		const plan = planPeerInjection([queued("q1", true)], history, {
			...options,
			delivered: (id) => id === "q1",
		});
		expect(plan.users).toEqual([]);
		expect(plan.delivering).toEqual(["row-q1"]);
		expect(plan.injected).toEqual(history);
	});
});

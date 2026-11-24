import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TURN_ALREADY_RUNNING } from "#/domain/api-turn-failure";
import { sendQueuingBehindRace } from "./send-race";

const refusal = () => new Error(TURN_ALREADY_RUNNING);

describe("a person's send that loses the race to a Y² wake (2026-11-24: the message disappeared, unanswered)", () => {
	it("is queued behind the wake's turn instead of refused, whether the send failed or threw", async () => {
		for (const send of [
			Effect.fail(refusal()),
			Effect.tryPromise(() => Promise.reject(refusal())),
			Effect.sync(() => {
				throw refusal();
			}),
		]) {
			const queue = vi.fn(async () => "queued view");
			expect(
				await Effect.runPromise(
					sendQueuingBehindRace(
						send as unknown as Effect.Effect<string>,
						queue,
					),
				),
			).toBe("queued view");
			expect(queue).toHaveBeenCalledOnce();
		}
	});

	it("leaves a send that may not queue (a merged batch, the queue's own delivery) to fail as before", async () => {
		await expect(
			Effect.runPromise(
				sendQueuingBehindRace(
					Effect.fail(refusal()) as unknown as Effect.Effect<string>,
					null,
				),
			),
		).rejects.toThrow(TURN_ALREADY_RUNNING);
	});

	it("never touches any other failure, and keeps the refusal when queueing is not possible either", async () => {
		const queue = vi.fn(async () => "queued view");
		await expect(
			Effect.runPromise(
				sendQueuingBehindRace(
					Effect.fail(
						new Error("The model connection changed."),
					) as unknown as Effect.Effect<string>,
					queue,
				),
			),
		).rejects.toThrow("The model connection changed.");
		expect(queue).not.toHaveBeenCalled();
		await expect(
			Effect.runPromise(
				sendQueuingBehindRace(
					Effect.fail(refusal()) as unknown as Effect.Effect<string>,
					async () => null,
				),
			),
		).rejects.toThrow(TURN_ALREADY_RUNNING);
	});

	it("answers a send that succeeds without asking the queue", async () => {
		const queue = vi.fn(async () => "queued view");
		expect(
			await Effect.runPromise(
				sendQueuingBehindRace(Effect.succeed("sent"), queue),
			),
		).toBe("sent");
		expect(queue).not.toHaveBeenCalled();
	});
});

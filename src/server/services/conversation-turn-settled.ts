import { randomUUID } from "node:crypto";
import { RecoveryRefused } from "#/domain/conversation-recovery-failure";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";

export const TURN_STILL_FINISHING =
	"The last turn is still finishing. Try again in a moment.";
export const TURN_HOLD_LOST =
	"Lost hold of this chat while restoring it. Try again in a moment.";

/** Renews well inside the coordinator's 30s lease, like a running turn. */
const RENEW_EVERY_MS = 10_000;
const RELEASE_ATTEMPTS = 3;

export type SettledConversationTurnHold = {
	/** Throws when a renewal failed, so the lease may have lapsed meanwhile. */
	assertHeld(): void;
	/** Stops renewing and releases the lease; safe to call more than once. */
	release(): Promise<void>;
};

/**
 * Confirms the chat's last turn has fully settled, without waiting, and holds
 * its coordination lease (renewing it) until released.
 *
 * A stopped turn reads idle as soon as it is finalized, but its runner still
 * stops its commands (and may land a last tool write) before it releases the
 * chat's coordination lease. Acquiring that lease under a fresh identity
 * succeeds only once the previous turn released it (or its lease expired), and
 * holding it keeps a restarted runner from reclaiming the old turn meanwhile,
 * however long the work under it (waking a VM, restoring code) takes.
 */
export async function holdSettledConversationTurn(
	userId: string,
	sessionId: string,
): Promise<SettledConversationTurnHold> {
	const probe = {
		userId,
		sessionId,
		turnId: randomUUID(),
		leaseId: randomUUID(),
		// Not a turn: a new turn waits for it instead of taking the lock over.
		hold: "restore" as const,
	};
	const acquired = await coordinateConversationTurn("acquire", probe).catch(
		() => {
			throw new RecoveryRefused(
				"Could not confirm the last turn has finished. Try again in a moment.",
			);
		},
	);
	if (!acquired) throw new RecoveryRefused(TURN_STILL_FINISHING);
	let lost = false;
	let renewing: Promise<void> = Promise.resolve();
	const timer = setInterval(() => {
		renewing = renewing.then(() =>
			coordinateConversationTurn("renew", probe).then(
				(alive) => {
					if (!alive) lost = true;
				},
				() => {
					lost = true;
				},
			),
		);
	}, RENEW_EVERY_MS);
	timer.unref?.();
	let released: Promise<void> | undefined;
	return {
		assertHeld() {
			if (lost) throw new RecoveryRefused(TURN_HOLD_LOST);
		},
		release() {
			released ??= (async () => {
				clearInterval(timer);
				await renewing;
				// A new turn waits for this lease, so retry a failed release; an
				// unreleased probe still expires with its lease.
				for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
					try {
						await coordinateConversationTurn("release", probe);
						return;
					} catch {
						if (attempt < RELEASE_ATTEMPTS)
							await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
			})();
			return released;
		},
	};
}

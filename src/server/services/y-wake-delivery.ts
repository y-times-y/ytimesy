import { parseClaudeCodeRouteId } from "#/domain/claude-code-route";
import { wakeMessageId } from "#/domain/pull-request-wake";
import type { WakeGate } from "./y-wake-gate";

/** What a wake did: it reached Y², Y² is dormant, or Y² is mid-turn and the wake should wait for it. */
export type WakeDelivery =
	| boolean
	| { readonly skipped: string }
	| { readonly held: "busy" };

export type WakeDeliveryDeps = {
	readonly gate: (chat: {
		readonly harness: string;
		readonly listedModelId: string | null;
	}) => Promise<WakeGate>;
	/** Whether Y²'s chat has a turn running or queued. */
	readonly busy: (chat: {
		readonly turnStatus?: string | null;
	}) => Promise<boolean>;
	/** Puts the message in Y²'s mailbox for its running turn's next step. */
	readonly stage: (id: string, message: string) => Promise<void>;
	readonly accepted: (id: string) => Promise<boolean>;
	/** Takes back a staged message no step has taken. */
	readonly unstage: (id: string) => Promise<void>;
	/** Starts a turn (idle) or queues behind the running one. */
	readonly send: (gate: Extract<WakeGate, { ok: true }>) => Promise<void>;
};

/** What Y² reads when a wake arrives in the middle of its own turn. */
export const STEERED_WAKE_NOTE =
	"This arrived while you were working on your current reply. Fold it into that reply (do not restart, and do not repeat what you already said); if nothing here needs the person, carry on.";

/**
 * Delivers one wake to Y²'s chat. Idle: a new turn. Mid-turn on a route that
 * takes steering (the API and Codex harness: the message joins the running turn
 * at its next model step, no extra turn): steered. Mid-turn on a Claude plan
 * run (its hooks take only a person's own sends): held, so everything that
 * arrives meanwhile goes out as one wake right after (`queueBehind` once held
 * too long). The dormancy gate (no model, plan nearly full, daily cap) runs
 * after the busy check, so a held wake never counts against the user's cap.
 */
export async function deliverY2Wake(
	deps: WakeDeliveryDeps,
	input: {
		readonly target: { readonly sessionId: string };
		readonly at: number;
		readonly body: string;
		readonly chat: {
			readonly harness: string;
			readonly listedModelId: string | null;
			readonly turnStatus?: string | null;
		};
		readonly queueBehind?: boolean;
	},
): Promise<WakeDelivery> {
	const busy = await deps.busy(input.chat);
	const listedClaude = Boolean(
		input.chat.listedModelId &&
			parseClaudeCodeRouteId(input.chat.listedModelId),
	);
	if (busy && listedClaude && !input.queueBehind) return { held: "busy" };
	const gate = await deps.gate(input.chat);
	if (!gate.ok) return { skipped: gate.reason };
	if (busy && !parseClaudeCodeRouteId(gate.modelId) && !input.queueBehind) {
		const id = wakeMessageId(`y2:${input.target.sessionId}:${input.at}`);
		await deps.stage(id, `${STEERED_WAKE_NOTE}\n\n${input.body}`);
		// The turn may have ended just before its step read the mailbox: take
		// the message back and start a turn with it instead of leaving it unread.
		if (await deps.busy(input.chat)) return true;
		if (await deps.accepted(id)) return true;
		await deps.unstage(id);
	}
	await deps.send(gate);
	return true;
}

import { ApiTurnCancelled } from "../../domain/api-turn-failure";
import type { TurnBoxGrant } from "../../domain/turn-box-grant";
import {
	boxSocketMessage,
	type TurnBoxEdgeSocketMessage,
} from "../../domain/turn-box-protocol";
import type { TurnBoxEdgeOps } from "./turn-box-routes";

/**
 * The chat Durable Object's end of a turn's ONE box socket
 * (docs/turn-runner-boxes.md). The socket is hibernatable
 * (ctx.acceptWebSocket): while the box is idle waiting on a model or a tool,
 * the object sleeps and bills no duration; each incoming message bills 1/20
 * of a request. The box sends coalesced progress (<= 1 message per ~500 ms)
 * and the lease renewal here instead of an HTTP request per event; the
 * object pushes Stop to the box over the same socket. Every database write
 * goes through the lease-checked writers (TurnBoxEdgeOps), so a zombie box
 * on a lost lease is fenced exactly as over HTTP.
 */
export const TURN_BOX_SOCKET_TAG = "turn-box";
const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

/** What a socket remembers across hibernation (serializeAttachment). */
export type TurnBoxSocketAttachment = Pick<
	TurnBoxGrant,
	"userId" | "sessionId" | "turnId" | "leaseId" | "boxId"
>;

export type TurnBoxSocketOps = Pick<
	TurnBoxEdgeOps,
	"loadOwned" | "renew" | "progress" | "cancelRequested" | "boxActive"
>;

/** The reply for one message from the box; `close` when it is malformed. */
export async function answerTurnBoxSocketMessage(
	attachment: TurnBoxSocketAttachment,
	message: string | ArrayBuffer,
	ops: TurnBoxSocketOps,
	now = Date.now(),
): Promise<{ reply: TurnBoxEdgeSocketMessage[]; close: boolean }> {
	if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS)
		return { reply: [], close: true };
	let parsed: ReturnType<typeof boxSocketMessage.safeParse>;
	try {
		parsed = boxSocketMessage.safeParse(JSON.parse(message));
	} catch {
		return { reply: [], close: true };
	}
	if (!parsed.success) return { reply: [], close: true };
	const grant: TurnBoxGrant = { ...attachment, expiresAt: now, nonce: "" };
	const lost = async (
		turn: Parameters<TurnBoxEdgeOps["cancelRequested"]>[0] | null,
	): Promise<TurnBoxEdgeSocketMessage> =>
		turn && (await ops.cancelRequested(turn))
			? { t: "cancel" }
			: { t: "lease-lost" };
	// The same first check as every HTTP endpoint: running under this lease.
	const turn = await ops.loadOwned(grant);
	if (!turn) return { reply: [{ t: "lease-lost" }], close: false };
	const seq = parsed.data.seq;
	// Claude relay messages are the chat object's own (claude-relay.ts).
	if (parsed.data.t !== "renew" && parsed.data.t !== "progress")
		return { reply: [], close: false };
	if (parsed.data.t === "renew") {
		if (!(await ops.boxActive(attachment.boxId)))
			return { reply: [{ t: "lease-lost" }], close: true };
		return (await ops.renew(turn))
			? { reply: [{ t: "ack", seq, ok: true }], close: false }
			: { reply: [await lost(turn)], close: false };
	}
	try {
		await ops.progress(turn, parsed.data.items);
		return { reply: [{ t: "ack", seq, ok: true }], close: false };
	} catch (error) {
		if (error instanceof ApiTurnCancelled)
			return { reply: [{ t: "cancel" }], close: false };
		if (error instanceof Error && /lease was lost/i.test(error.message))
			return { reply: [await lost(turn)], close: false };
		throw error;
	}
}

/** Pushes Stop to the box running `turnId` over its socket (a sleeping object is woken by the Stop request that calls this). */
export function pushCancelToTurnBox(
	sockets: readonly { send(data: string): void }[],
) {
	const text = JSON.stringify({
		t: "cancel",
	} satisfies TurnBoxEdgeSocketMessage);
	for (const socket of sockets) {
		try {
			socket.send(text);
		} catch {
			// A socket that already closed: the box's renewal learns of the stop.
		}
	}
}

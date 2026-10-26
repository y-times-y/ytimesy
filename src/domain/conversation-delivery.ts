import { z } from "zod";

/** Reconnects replace the latest snapshot; they never replay model inference. */
export const conversationSnapshotSchema = z.object({
	userId: z.string().min(1).max(256),
	sessionId: z.uuid(),
	revision: z.string().regex(/^[1-9]\d{0,19}$/),
	progress: z.object({
		sessionId: z.uuid(),
		items: z.array(z.unknown()),
		/** The items are the chat's last turns; it holds turns before them. */
		hasOlderItems: z.boolean().optional(),
		turnStatus: z.enum(["idle", "running", "completed", "failed"]),
		usage: z.unknown().optional(),
	}),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export const MAX_DELIVERY_BYTES = 4 * 1024 * 1024;

export function conversationEvent(snapshot: ConversationSnapshot) {
	return `retry: 250\nid: ${snapshot.revision}\nevent: progress\ndata: ${JSON.stringify({ ...snapshot.progress, sessionId: snapshot.sessionId })}\n\n`;
}

import { z } from "zod";

export const turnControlSchema = z.object({
	userId: z.string().min(1).max(200),
	sessionId: z.string().uuid(),
	turnId: z.string().uuid(),
	leaseId: z.string().uuid(),
});
export type TurnControl = z.infer<typeof turnControlSchema>;
export type ActiveConversationTurn = TurnControl & {
	expiresAt: number;
	cancelled: boolean;
};
export const TURN_COORDINATION_LEASE_MS = 30_000;

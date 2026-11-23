import { modelConversationName } from "../../domain/model-conversation-routing";
import { deliverTurnSettleNotesDirectly } from "../adapters/turn-settle-notes";
import { deliverUserHubNotesDirectly } from "../adapters/user-hub-notes";
import { deliverYSquaredCrewDirectly } from "../adapters/y-squared-crew-client";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";

/** Edge code tells a user's hub what changed through this Worker's own binding. */
export function registerUserHubNotes(env: EdgeExecutorEnvironment) {
	deliverUserHubNotesDirectly((userId, topics) =>
		env.USER_HUBS.getByName(userId, durableObjectLocation()).noteSignals(
			topics,
		),
	);
	// A turn the lease sweep failed: its chat's object tells the crew and the
	// hub, as it does for a box turn (noteBoxTurn; no items: what the turn
	// last showed stays as the crew has it).
	deliverTurnSettleNotesDirectly((note) =>
		env.MODEL_CONVERSATIONS.getByName(
			modelConversationName(note),
			durableObjectLocation(),
		).noteBoxTurn({
			userId: note.userId,
			sessionId: note.sessionId,
			turnId: note.turnId,
			leaseId: "",
			turnStatus: note.turnStatus,
			items: [],
		}),
	);
	// Y²'s tools read a project's crew through its Durable Object.
	deliverYSquaredCrewDirectly((projectId) => {
		const crew = () =>
			env.Y_SQUARED_CREWS.getByName(projectId, durableObjectLocation());
		return {
			list: () => crew().list(),
			thread: (sessionId) => crew().thread(sessionId),
			reconcile: (rows) => crew().reconcile(rows),
			noteWaiting: (hint) => crew().noteWaiting(hint),
			noteY2Sent: (sessionId) => crew().noteY2Sent(sessionId),
			schedule: (input, target) => crew().schedule(input, target),
			proactive: () => crew().proactive(),
			saveSettings: (patch) => crew().saveSettings(patch),
			cancelSchedule: (id) => crew().cancelSchedule(id),
		};
	});
}

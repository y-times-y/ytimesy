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
		};
	});
}

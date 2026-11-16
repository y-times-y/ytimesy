import { deliverUserHubNotesDirectly } from "../adapters/user-hub-notes";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";

/** Edge code tells a user's hub what changed through this Worker's own binding. */
export function registerUserHubNotes(env: EdgeExecutorEnvironment) {
	deliverUserHubNotesDirectly((userId, topics) =>
		env.USER_HUBS.getByName(userId, durableObjectLocation()).noteSignals(
			topics,
		),
	);
}

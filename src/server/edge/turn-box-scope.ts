import type { BackgroundJob } from "#/domain/background-job";
import { withBackgroundJobDispatcher } from "../adapters/background-job-dispatch";
import { withDatabaseScope } from "../adapters/database-scope";

/**
 * One box request's scope: its own database scope and the edge's background
 * job binding, as a step in the chat's object has. Without the binding a job
 * a port starts (a helper's steering message, a peer message, a checkpoint)
 * fell back to pg-boss, which the Worker does not have: every agent_send
 * from a turn on a box failed with 503 "pg-boss is not installed"
 * (2026-11-23).
 */
export function turnBoxRequestScope(
	connectionString: string,
	dispatch: (job: BackgroundJob) => Promise<void>,
) {
	return <T>(run: () => Promise<T>) =>
		withDatabaseScope(
			connectionString,
			() => withBackgroundJobDispatcher(dispatch, run),
			null,
		);
}

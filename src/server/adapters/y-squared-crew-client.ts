import type { CrewRow, CrewWaitingHint } from "#/domain/y-squared-crew";

/** One project's YSquaredCrew, as Y²'s tools call it (one request each). */
export type YSquaredCrewClient = {
	list(): Promise<{ reconciled: boolean; rows: CrewRow[] }>;
	thread(sessionId: string): Promise<CrewRow | null>;
	reconcile(rows: readonly CrewRow[]): Promise<void>;
	/** Y² is about to send into a thread (null: a new one): its turn start is not the person's. */
	noteY2Sent?(sessionId: string | null): Promise<void>;
	/** A thread ended its turn on a card only the person can answer (see noteCrewWaiting). */
	noteWaiting(hint: CrewWaitingHint): Promise<void>;
};

let forProject: ((projectId: string) => YSquaredCrewClient) | null = null;

/**
 * The edge executor registers its Durable Object binding here, so the tools
 * (which also load outside the edge) never import a Cloudflare module. With
 * nothing registered, Y²'s tools read only the sidebar's metadata.
 */
export function deliverYSquaredCrewDirectly(
	factory: ((projectId: string) => YSquaredCrewClient) | null,
) {
	forProject = factory;
}

export function ySquaredCrewFor(projectId: string): YSquaredCrewClient | null {
	return forProject ? forProject(projectId) : null;
}

/**
 * Tells the project's crew a thread is waiting on the person, from where the
 * turn knows it (api-turn.ts), so Y² does not see the thread as finished when
 * the chat object's own transcript copy was empty at the settle note. One
 * tiny fire-and-forget request; the crew merges it into the settle note.
 * Nothing without a crew binding (local development, a box: the box's port
 * reaches this through the edge).
 */
export function noteCrewWaiting(hint: CrewWaitingHint): void {
	const crew = ySquaredCrewFor(hint.projectId);
	if (!crew) return;
	void crew.noteWaiting(hint).catch((error: unknown) =>
		console.warn("Crew was not told the thread waits.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "?",
		}),
	);
}

import type { CrewRow, CrewWaitingHint } from "#/domain/y-squared-crew";
import type {
	ScheduleView,
	YSquaredSettings,
} from "#/domain/y-squared-proactive";

/** The proactive side as the settings and Y²'s `schedule` tool read it (one Durable Object request each). */
export type YSquaredProactiveStatus = {
	readonly settings: YSquaredSettings;
	readonly schedules: readonly ScheduleView[];
	readonly proactiveToday: number;
	readonly proactiveLimit: number;
};
export type YSquaredScheduleResult =
	| { readonly ok: false; readonly error: string }
	| {
			readonly ok: true;
			readonly action: "create";
			readonly schedule: ScheduleView;
			/** True when no time zone was saved or given: UTC was used. */
			readonly usedUtcFallback: boolean;
	  }
	| {
			readonly ok: true;
			readonly action: "list";
			readonly schedules: readonly ScheduleView[];
	  }
	| {
			readonly ok: true;
			readonly action: "cancel";
			readonly cancelled: boolean;
	  };

/** One project's YSquaredCrew, as Y²'s tools call it (one request each). */
export type YSquaredCrewClient = {
	list(): Promise<{ reconciled: boolean; rows: CrewRow[] }>;
	thread(sessionId: string): Promise<CrewRow | null>;
	reconcile(rows: readonly CrewRow[]): Promise<void>;
	/** Y² is about to send into a thread (null: a new one): its turn start is not the person's. */
	noteY2Sent?(sessionId: string | null): Promise<void>;
	/** A thread ended its turn on a card only the person can answer (see noteCrewWaiting). */
	noteWaiting(hint: CrewWaitingHint): Promise<void>;
	/** Y²'s `schedule` tool: create, list or cancel (the crew validates and stores). */
	schedule?(
		input: unknown,
		target: { userId: string; ySquaredId: string },
	): Promise<YSquaredScheduleResult>;
	/** Settings, active schedules and the daily proactive-wake count. */
	proactive?(): Promise<YSquaredProactiveStatus>;
	saveSettings?(patch: unknown): Promise<YSquaredSettings>;
	cancelSchedule?(id: string): Promise<boolean>;
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
